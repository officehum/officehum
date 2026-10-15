import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localFileStore } from "./index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-files-"));
  dirs.push(dir);
  return { dir, store: localFileStore(dir) };
}

const metadata = { createdBy: "role:test", source: "uploaded" as const };
const putText = (store: ReturnType<typeof localFileStore>) =>
  store.put({
    bytes: new TextEncoder().encode("hello"),
    name: "a.txt",
    mimeType: "text/plain",
    metadata,
  });

it("persists immutable bytes across reopen", async () => {
  const { dir, store } = await setup();
  const bytes = new TextEncoder().encode("hello");
  const ref = await store.put({ bytes, name: "note.txt", mimeType: "text/plain", metadata });
  expect(ref.id).toMatch(/^file_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(ref.size).toBe(5);
  expect(await localFileStore(dir).get(ref.id)).toEqual({ ref, bytes });
  expect(await store.info(ref.id)).toEqual(ref);
  bytes[0] = 0;
  expect((await store.get(ref.id))?.bytes[0]).toBe(104);
});

it("snapshots name and MIME before the first await", async () => {
  const { dir, store } = await setup();
  const input = {
    bytes: new TextEncoder().encode("hello"),
    name: "note.txt",
    mimeType: "text/plain",
    metadata,
  };
  const pending = store.put(input);
  input.name = "../escaped.txt";
  input.mimeType = "image/png";
  const ref = await pending;

  expect(ref.name).toBe("note.txt");
  expect(ref.mimeType).toBe("text/plain");
  expect(await store.get(ref.id)).toMatchObject({
    ref: { name: "note.txt", mimeType: "text/plain" },
  });
  await expect(
    import("node:fs/promises").then(({ access }) => access(join(dir, "escaped.txt"))),
  ).rejects.toThrow();
});

it.each(["../x", "x/y", "x\\y", "", ".", "..", "meta.json"])("rejects name %j", async (name) => {
  const { store } = await setup();
  await expect(
    store.put({ bytes: new Uint8Array(), name, mimeType: "text/plain", metadata }),
  ).rejects.toThrow();
});

it.each(["../escape", "file_../../x", "file_bad"])("rejects id %j", async (id) => {
  const { store } = await setup();
  await expect(store.get(id)).rejects.toThrow();
  await expect(store.info(id)).rejects.toThrow();
});

it("refuses tampered bytes on get and info", async () => {
  const { dir, store } = await setup();
  const ref = await putText(store);
  await writeFile(join(dir, ref.id, ref.name), "changed");
  await expect(store.get(ref.id)).rejects.toThrow();
  await expect(store.info(ref.id)).rejects.toThrow();
});

it("refuses corrupt metadata", async () => {
  const { dir, store } = await setup();
  const ref = await putText(store);
  await writeFile(join(dir, ref.id, "meta.json"), "{}");
  await expect(store.get(ref.id)).rejects.toThrow();
});

it("does not follow a metadata file symlink", async () => {
  const { dir, store } = await setup();
  const target = await setup();
  const ref = await putText(store);
  const targetMetadata = join(target.dir, "meta.json");
  await writeFile(targetMetadata, JSON.stringify(ref));
  await unlink(join(dir, ref.id, "meta.json"));
  await symlink(targetMetadata, join(dir, ref.id, "meta.json"));

  await expect(store.get(ref.id)).rejects.toThrow();
  await expect(store.info(ref.id)).rejects.toThrow();
});

it("does not follow a payload file symlink", async () => {
  const { dir, store } = await setup();
  const target = await setup();
  const ref = await putText(store);
  const targetPayload = join(target.dir, "payload.txt");
  await writeFile(targetPayload, "hello");
  await unlink(join(dir, ref.id, ref.name));
  await symlink(targetPayload, join(dir, ref.id, ref.name));

  await expect(store.get(ref.id)).rejects.toThrow();
  await expect(store.info(ref.id)).rejects.toThrow();
});

it("does not follow a version directory symlink", async () => {
  const { dir, store } = await setup();
  const target = await setup();
  const ref = await putText(target.store);
  await symlink(join(target.dir, ref.id), join(dir, ref.id), "dir");
  await expect(store.get(ref.id)).rejects.toThrow();
  await expect(store.info(ref.id)).rejects.toThrow();
});

it("ignores abandoned staging after reopen", async () => {
  const { dir } = await setup();
  await mkdir(join(dir, ".staging-abandoned"));
  await writeFile(join(dir, ".staging-abandoned", "payload"), "sentinel");
  const reopened = localFileStore(dir);
  const ref = await putText(reopened);
  expect(new TextDecoder().decode((await reopened.get(ref.id))?.bytes)).toBe("hello");
});

it("snapshots caller metadata", async () => {
  const { store } = await setup();
  const mutable = { ...metadata };
  const ref = await store.put({
    bytes: new Uint8Array(),
    name: "x.txt",
    mimeType: "text/plain",
    metadata: mutable,
  });
  mutable.createdBy = "changed";
  expect((await store.info(ref.id))?.metadata.createdBy).toBe("role:test");
});

it("rejects sparse derivedFrom metadata before installing a completed file", async () => {
  const { dir, store } = await setup();
  const derivedFrom = new Array<string>(1);

  await expect(
    store.put({
      bytes: new Uint8Array(),
      name: "derived.txt",
      mimeType: "text/plain",
      metadata: { ...metadata, source: "derived", derivedFrom },
    }),
  ).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});

it.each(["text/plain\u0000evil", "x".repeat(256)])(
  "rejects invalid MIME type %j before persistence",
  async (mimeType) => {
    const { dir, store } = await setup();
    await expect(
      store.put({ bytes: new Uint8Array(), name: "mime.txt", mimeType, metadata }),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  },
);

it("returns a FileRef from put that fileResult accepts", async () => {
  const { store } = await setup();
  const ref = await putText(store);
  const { fileResult } = await import("./files.js");

  expect(fileResult([ref]).details.files).toEqual([ref.id]);
});

it.each([
  ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
  ["image/jpeg", [255, 216, 255]],
  ["image/gif", [...Buffer.from("GIF89a")]],
  ["image/webp", [...Buffer.from("RIFF0000WEBP")]],
  ["application/pdf", [...Buffer.from("%PDF-")]],
] as const)("checks signature for %s", async (mimeType, prefix) => {
  const { store } = await setup();
  const bytes = Uint8Array.from(prefix);
  await expect(store.put({ bytes, name: "payload", mimeType, metadata })).resolves.toMatchObject({
    mimeType,
  });
  await expect(
    store.put({ bytes, name: "payload", mimeType: "text/plain", metadata }),
  ).rejects.toThrow();
  await expect(
    store.put({ bytes: bytes.slice(0, 1), name: "payload", mimeType, metadata }),
  ).rejects.toThrow();
});

it("keeps concurrent writes distinct", async () => {
  const { store } = await setup();
  const refs = await Promise.all(Array.from({ length: 20 }, () => putText(store)));
  expect(new Set(refs.map((ref) => ref.id)).size).toBe(20);
  for (const ref of refs) expect(await store.info(ref.id)).toEqual(ref);
});

it.each(["x".repeat(256), "a\u0000b"])("refuses oversized or control names", async (name) => {
  const { store } = await setup();
  await expect(
    store.put({ bytes: new Uint8Array(), name, mimeType: "text/plain", metadata }),
  ).rejects.toThrow();
});

it("refuses external provenance relabeling", async () => {
  const { store } = await setup();
  await expect(
    store.put({
      bytes: new Uint8Array(),
      name: "a",
      mimeType: "text/plain",
      metadata: { createdBy: "email", source: "external", provenance: "internal" },
    }),
  ).rejects.toThrow();
});

it("returns undefined for absent valid IDs", async () => {
  const { store } = await setup();
  expect(await store.get("file_00000000000000000000000000")).toBeUndefined();
});
