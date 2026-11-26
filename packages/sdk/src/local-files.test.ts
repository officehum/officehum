import { mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStoreContract } from "./fixtures/file-store-contract.js";
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

describe("the FileStore contract", () => {
  fileStoreContract(async () => {
    const { dir, store } = await setup();
    return {
      store,
      reopen: async () => localFileStore(dir),
      peer: async () => localFileStore(dir),
      corrupt: (ref) => writeFile(join(dir, ref.id, ref.name), "changed"),
      stored: async () => (await readdir(dir)).length > 0,
    };
  });
});

const metadata = { createdBy: "role:test", source: "uploaded" as const };
const putText = (store: ReturnType<typeof localFileStore>) =>
  store.put({
    bytes: new TextEncoder().encode("hello"),
    name: "a.txt",
    mimeType: "text/plain",
    metadata,
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
