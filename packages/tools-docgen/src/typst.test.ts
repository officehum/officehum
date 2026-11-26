/**
 * The Typst runner against a fake `typst`: the exact command, the scrubbed environment, the
 * directory it compiles in, the version check, the time limit and the page count. These run
 * everywhere; `typst-real.test.ts` runs the real compiler where it is installed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeTypst, removeTempDirs, tempDir } from "./test-helpers.js";
import {
  checkTypst,
  pdfPageCount,
  resolveTypst,
  runTypst,
  runTypstSync,
  TYPST_VARIABLE,
  TYPST_VERSION,
  type TypstJob,
} from "./typst.js";

afterEach(removeTempDirs);

function job(binary: string, source: string, overrides: Partial<TypstJob> = {}): TypstJob {
  return {
    binary,
    main: "quote.typ",
    files: { "quote.typ": source, "data.json": '{"total":1}' },
    format: "pdf",
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("finding Typst", () => {
  it("takes the binary named by OFFICEHUM_TYPST, else typst on the PATH", () => {
    const fake = fakeTypst();
    expect(TYPST_VARIABLE).toBe("OFFICEHUM_TYPST");
    expect(resolveTypst({ OFFICEHUM_TYPST: fake.binary, PATH: "" })).toBe(fake.binary);
    expect(resolveTypst({ PATH: join(fake.binary, "..") })).toBe(fake.binary);
    expect(resolveTypst({ PATH: tempDir() })).toBeUndefined();
    expect(resolveTypst({})).toBeUndefined();
  });

  it("checks the version against the pin", () => {
    expect(checkTypst(fakeTypst().binary)).toEqual({
      ok: true,
      binary: expect.any(String),
      version: TYPST_VERSION,
    });
    expect(checkTypst(fakeTypst("0.12.0").binary)).toEqual({
      ok: false,
      code: "typst-version",
      message: `Typst 0.12.0 is installed, but documents are rendered with Typst ${TYPST_VERSION} exactly; install ${TYPST_VERSION} or point ${TYPST_VARIABLE} at it`,
    });
    expect(checkTypst(undefined)).toMatchObject({ ok: false, code: "typst-missing" });
    expect(checkTypst(join(tempDir(), "typst"))).toMatchObject({
      ok: false,
      code: "typst-missing",
    });
  });
});

describe("compiling", () => {
  it("runs a fixed command in a fresh directory holding only the given files", async () => {
    const fake = fakeTypst();
    const outcome = await runTypst(job(fake.binary, "= Quote"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Buffer.from(outcome.bytes).toString("latin1")).toMatch(/^%PDF-/u);

    const [run] = fake.runs();
    if (run === undefined) throw new Error("typst did not run");
    const root = run.args[run.args.indexOf("--root") + 1] ?? "";
    expect(run.args).toEqual([
      "compile",
      "--root",
      root,
      "--diagnostic-format",
      "short",
      "--format",
      "pdf",
      join(root, "quote.typ"),
      join(root, "..", "out.pdf"),
    ]);
    expect(run.cwd).toBe(root);
    expect(Object.keys(run.files).sort()).toEqual(["data.json", "quote.typ"]);
    // The directory is gone afterwards: nothing of one document is left for the next.
    expect(existsSync(root)).toBe(false);
  });

  it("gives Typst an environment with no secrets, no home and no way to fetch packages", async () => {
    const fake = fakeTypst();
    process.env.OFFICEHUM_TEST_SECRET_TOKEN = "do-not-pass";
    try {
      await runTypst(job(fake.binary, "= Quote"));
    } finally {
      delete process.env.OFFICEHUM_TEST_SECRET_TOKEN;
    }
    const env = fake.runs()[0]?.env ?? {};
    const root = fake.runs()[0]?.cwd ?? "";
    const own = Object.fromEntries(
      Object.entries(env).filter(
        ([name]) => !["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(name),
      ),
    );
    expect(own).toEqual({
      LANG: "C.UTF-8",
      TYPST_PACKAGE_PATH: join(root, "..", "packages"),
      TYPST_PACKAGE_CACHE_PATH: join(root, "..", "package-cache"),
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      all_proxy: "http://127.0.0.1:9",
      NO_PROXY: "",
      no_proxy: "",
    });
  });

  it("asks for one page as PNG for a preview", async () => {
    const fake = fakeTypst();
    const outcome = await runTypst(job(fake.binary, "= Quote", { format: "png", ppi: 48 }));
    expect(outcome.ok).toBe(true);
    const args = fake.runs()[0]?.args ?? [];
    expect(args.slice(5, 11)).toEqual(["--format", "png", "--pages", "1", "--ppi", "48"]);
  });

  it("reports a compile error with the template's own file name, not the temporary path", async () => {
    const fake = fakeTypst();
    expect(await runTypst(job(fake.binary, "FAKE_ERROR"))).toEqual({
      ok: false,
      code: "compile-failed",
      message: "quote.typ:2:5: error: unknown variable: nope",
    });
    expect(runTypstSync(job(fake.binary, "FAKE_ERROR"))).toEqual({
      ok: false,
      code: "compile-failed",
      message: "quote.typ:2:5: error: unknown variable: nope",
    });
  });

  it("stops a compile that runs past its time limit", async () => {
    const fake = fakeTypst();
    const started = Date.now();
    expect(await runTypst(job(fake.binary, "FAKE_SLEEP", { timeoutMs: 300 }))).toEqual({
      ok: false,
      code: "timeout",
      message: "Typst did not finish within 0.3 s and was stopped",
    });
    expect(runTypstSync(job(fake.binary, "FAKE_SLEEP", { timeoutMs: 300 }))).toMatchObject({
      ok: false,
      code: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("refuses a file name that could leave the directory", async () => {
    const fake = fakeTypst();
    await expect(
      runTypst(job(fake.binary, "x", { files: { "../x.typ": "x" }, main: "../x.typ" })),
    ).rejects.toThrow(/one plain file name/u);
    expect(fake.runs()).toEqual([]);
  });
});

describe("counting pages", () => {
  it("reads the page tree's count, and nothing when there is none", () => {
    const pdf = (body: string) => new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF`);
    expect(pdfPageCount(pdf("1 0 obj\n<<\n  /Type /Pages\n  /Count 3\n  /Kids [2 0 R]\n>>"))).toBe(
      3,
    );
    expect(pdfPageCount(pdf("<< /Type /Outlines /Count 9 >> << /Type /Pages /Count 2 >>"))).toBe(2);
    expect(pdfPageCount(pdf("no page tree here"))).toBeUndefined();
  });
});
