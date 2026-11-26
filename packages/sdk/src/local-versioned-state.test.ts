import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mutateState, readState } from "./local-versioned-state.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "officehum-version-state-"));
  dirs.push(dir);
  return dir;
}

it("persists a detached manifest and serializes separate callers", async () => {
  const dir = await setup();
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  let secondEntered = false;
  const firstPending = mutateState(dir, async (state) => {
    markFirstEntered();
    await held;
    return state;
  });
  await firstEntered;
  const secondPending = mutateState(dir, async (state) => {
    secondEntered = true;
    return state;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondEntered).toBe(false);
  } finally {
    releaseFirst();
  }
  const [first, second] = await Promise.all([firstPending, secondPending]);
  expect(secondEntered).toBe(true);
  expect(first).toEqual({ schema: 1, files: {}, versions: {}, operations: {} });
  expect(second).toEqual(first);
  expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))).toEqual(first);
  (first.files as Record<string, unknown>).changed = {};
  expect(await readState(dir)).toEqual(second);
});

it("failed mutation preserves the prior snapshot and releases its lock", async () => {
  const dir = await setup();
  await mutateState(dir, async () => undefined);
  const before = await readFile(join(dir, "manifest.json"), "utf8");
  await expect(
    mutateState(dir, async () => {
      throw new Error("injected failure");
    }),
  ).rejects.toThrow("injected failure");
  expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe(before);
  await expect(mutateState(dir, async () => "recovered")).resolves.toBe("recovered");
});

it("uncloneable results do not commit state and release the lock", async () => {
  const dir = await setup();
  await expect(mutateState(dir, async () => () => undefined)).rejects.toThrow();
  await expect(readFile(join(dir, "manifest.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(mutateState(dir, async () => "recovered")).resolves.toBe("recovered");
});

it("corrupt snapshots fail closed", async () => {
  const dir = await setup();
  await writeFile(join(dir, "manifest.json"), "{}");
  await expect(readState(dir)).rejects.toMatchObject({ code: "INTEGRITY" });
});

it("times out a preexisting lock without deleting it", async () => {
  const dir = await setup();
  await mkdir(join(dir, ".write-lock"));
  await expect(mutateState(dir, async () => undefined)).rejects.toMatchObject({ code: "BUSY" });
  await expect(mkdir(join(dir, ".write-lock"))).rejects.toMatchObject({ code: "EEXIST" });
}, 10_000);

/** A valid manifest holding one file whose versions form a single chain of `length`. */
function chainManifest(length: number) {
  const fileId = `file_${"0".repeat(26)}`;
  const versionId = (index: number) => `file_${String(index + 1).padStart(26, "0")}`;
  const versions = Object.fromEntries(
    Array.from({ length }, (_, index) => [
      versionId(index),
      {
        id: fileId,
        name: "report.txt",
        mimeType: "text/plain",
        size: 1,
        sha256: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: { createdBy: "test", source: "generated" },
        versionId: versionId(index),
        sourceVersionId: index === 0 ? null : versionId(index - 1),
        operationId: null,
        context: null,
      },
    ]),
  );
  return {
    schema: 1,
    files: { [fileId]: { initial: versionId(0), head: versionId(length - 1), published: null } },
    versions,
    operations: {},
  };
}

it("validates a manifest once per version of it, and hands each reader its own copy", async () => {
  const dir = await setup();
  await writeFile(join(dir, "manifest.json"), JSON.stringify(chainManifest(3)));
  const parse = vi.spyOn(JSON, "parse");
  const first = await readState(dir);
  const second = await readState(dir);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  (first.files as Record<string, unknown>).changed = {};
  expect(await readState(dir)).toEqual(second);

  // A write is validated as it is committed, so the read after it has nothing left to check.
  await mutateState(dir, async (state) => {
    for (const entry of Object.values(state.files)) entry.published = entry.head;
  });
  parse.mockClear();
  const written = await readState(dir);
  expect(parse).not.toHaveBeenCalled();
  expect(Object.values(written.files).map((entry) => entry.published)).toEqual([
    `file_${"3".padStart(26, "0")}`,
  ]);
  expect(written).toEqual(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
});

it("still fails closed when the manifest is changed behind a validated read", async () => {
  const dir = await setup();
  await writeFile(join(dir, "manifest.json"), JSON.stringify(chainManifest(3)));
  await readState(dir);
  const cyclic = chainManifest(3);
  const [, second, last] = Object.keys(cyclic.versions);
  (cyclic.versions[second as string] as { sourceVersionId: string | null }).sourceVersionId =
    last as string;
  await writeFile(join(dir, "manifest.json"), JSON.stringify(cyclic));
  await expect(readState(dir)).rejects.toMatchObject({
    code: "INTEGRITY",
    message: "Cyclic source version chain",
  });
});

it("walks a long version chain once, not once per version", async () => {
  const dir = await setup();
  await writeFile(join(dir, "manifest.json"), JSON.stringify(chainManifest(30_000)));
  const started = performance.now();
  const state = await readState(dir);
  expect(Object.keys(state.versions)).toHaveLength(30_000);
  // Quadratic, this chain is 450 million steps and takes tens of seconds.
  expect(performance.now() - started).toBeLessThan(3_000);
}, 60_000);
