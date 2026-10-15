import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mutateState, readState } from "./local-versioned-state.js";

const dirs: string[] = [];

afterEach(async () => {
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
