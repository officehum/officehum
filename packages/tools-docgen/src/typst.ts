/**
 * The Typst runner: the only place this pack starts a process or writes a file.
 *
 * Typst is a declared runtime (`typst`, pinned to `TYPST_VERSION`), found through `OFFICEHUM_TYPST`
 * (mirroring `OFFICEHUM_PAPER_PYTHON`) or on the PATH, and refused at any other version. Each
 * compile gets a fresh temporary directory holding only the files it is given (the template, its
 * helper library, `data.json`, `brand.json` and a copied logo), with `--root` set to it, so a
 * template cannot read anything outside it: Typst resolves even an absolute path inside the root.
 * The command is fixed, the environment is built from nothing, package downloads point at empty
 * directories behind an unreachable proxy, and the process is killed at its time limit.
 *
 * That is not a sandbox. The container profile is what takes the network
 * away for certain; until then this is defence in process, stated as such in the README.
 */

import { execFile, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** The Typst every document is rendered with. Change it here, in the README and in CI together. */
export const TYPST_VERSION = "0.13.1";

/** The environment variable naming the Typst binary, when it is not `typst` on the PATH. */
export const TYPST_VARIABLE = "OFFICEHUM_TYPST";

const UNREACHABLE_PROXY = "http://127.0.0.1:9";
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE = 2_000;

/** The binary to run: `OFFICEHUM_TYPST` when set, otherwise the first `typst` on the PATH. */
export function resolveTypst(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const named = env[TYPST_VARIABLE];
  if (named !== undefined && named !== "") return named;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, "typst");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

export type TypstStatus =
  | { readonly ok: true; readonly binary: string; readonly version: string }
  | {
      readonly ok: false;
      readonly code: "typst-missing" | "typst-version";
      readonly message: string;
    };

const checked = new Map<string, TypstStatus>();

const INSTALL_HINT = `install Typst ${TYPST_VERSION} and put it on the PATH, or set ${TYPST_VARIABLE} to its absolute path`;

/** Whether `binary` is Typst at the pinned version. Remembered per binary for the process. */
export function checkTypst(binary: string | undefined): TypstStatus {
  if (binary === undefined) {
    return { ok: false, code: "typst-missing", message: `Typst is not installed; ${INSTALL_HINT}` };
  }
  const known = checked.get(binary);
  if (known !== undefined) return known;
  const result = spawnSync(binary, ["--version"], { env: {}, timeout: 10_000, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const version = /typst (\d+\.\d+\.\d+)/u.exec(output)?.[1];
  const status: TypstStatus =
    result.error !== undefined || version === undefined
      ? {
          ok: false,
          code: "typst-missing",
          message: `${binary} does not run as Typst; ${INSTALL_HINT}`,
        }
      : version !== TYPST_VERSION
        ? {
            ok: false,
            code: "typst-version",
            message: `Typst ${version} is installed, but documents are rendered with Typst ${TYPST_VERSION} exactly; install ${TYPST_VERSION} or point ${TYPST_VARIABLE} at it`,
          }
        : { ok: true, binary, version };
  // A missing binary may be installed later; only a definite answer about one that ran is kept.
  if (status.ok || status.code === "typst-version") checked.set(binary, status);
  return status;
}

export interface TypstJob {
  readonly binary: string;
  /** Every file the compile may see, by plain file name: the only contents of its root. */
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  /** The file to compile, one of `files`. */
  readonly main: string;
  /** `pdf` for the document, `png` for a picture of its first page. */
  readonly format: "pdf" | "png";
  readonly timeoutMs: number;
  /** Pixels per inch for `png`. */
  readonly ppi?: number;
}

export type TypstOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly code: "compile-failed" | "timeout" | "output-invalid";
      readonly message: string;
    };

interface Prepared {
  readonly base: string;
  readonly root: string;
  readonly output: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

function prepare(job: TypstJob): Prepared {
  for (const name of Object.keys(job.files)) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(name) || name.includes("..")) {
      throw new Error(`a Typst input must be one plain file name, not ${JSON.stringify(name)}`);
    }
  }
  if (!(job.main in job.files))
    throw new Error(`the Typst input ${job.main} is not among the files`);
  // The real path, so the paths Typst prints are the ones stripped from its messages.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "officehum-typst-")));
  const root = join(base, "root");
  const packages = join(base, "packages");
  const cache = join(base, "package-cache");
  for (const dir of [root, packages, cache]) mkdirSync(dir, { mode: 0o700 });
  for (const [name, content] of Object.entries(job.files)) {
    writeFileSync(join(root, name), content, { mode: 0o600, flag: "wx" });
  }
  const output = join(base, `out.${job.format}`);
  const args = [
    "compile",
    "--root",
    root,
    "--diagnostic-format",
    "short",
    "--format",
    job.format,
    ...(job.format === "png" ? ["--pages", "1", "--ppi", String(job.ppi ?? 72)] : []),
    join(root, job.main),
    output,
  ];
  const env: Record<string, string> = {
    LANG: "C.UTF-8",
    TYPST_PACKAGE_PATH: packages,
    TYPST_PACKAGE_CACHE_PATH: cache,
  };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = UNREACHABLE_PROXY;
    env[name.toLowerCase()] = UNREACHABLE_PROXY;
  }
  env.NO_PROXY = "";
  env.no_proxy = "";
  return { base, root, output, args, env };
}

function finish(
  prepared: Prepared,
  failure: { timedOut: boolean; failed: boolean; stderr: string },
  timeoutMs: number,
): TypstOutcome {
  if (failure.timedOut) {
    return {
      ok: false,
      code: "timeout",
      message: `Typst did not finish within ${timeoutMs / 1000} s and was stopped`,
    };
  }
  if (failure.failed) {
    return { ok: false, code: "compile-failed", message: tidy(failure.stderr, prepared) };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(prepared.output));
  } catch {
    return {
      ok: false,
      code: "output-invalid",
      message: "Typst reported success but wrote nothing",
    };
  }
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    return {
      ok: false,
      code: "output-invalid",
      message: `the rendered file is ${bytes.byteLength} bytes; the limit is ${MAX_OUTPUT_BYTES}`,
    };
  }
  return { ok: true, bytes };
}

/** The compiler's message without the temporary directory in it, bounded. */
function tidy(stderr: string, prepared: Prepared): string {
  const text = stderr.split(`${prepared.root}/`).join("").split(prepared.base).join("").trim();
  const message = text === "" ? "Typst failed without saying why" : text;
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
}

/** Compiles one job. A refusal is an outcome; only a malformed job throws. */
export async function runTypst(job: TypstJob): Promise<TypstOutcome> {
  const prepared = prepare(job);
  return new Promise((resolve) => {
    execFile(
      job.binary,
      prepared.args,
      {
        cwd: prepared.root,
        env: prepared.env,
        timeout: job.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, _stdout, stderr) => {
        try {
          const timedOut =
            error !== null &&
            (error as { killed?: boolean }).killed === true &&
            error.signal === "SIGKILL";
          resolve(finish(prepared, { timedOut, failed: error !== null, stderr }, job.timeoutMs));
        } finally {
          rmSync(prepared.base, { recursive: true, force: true });
        }
      },
    );
  });
}

/**
 * The same compile, synchronously, for the overlay store's validation, which is synchronous. It
 * blocks the caller for at most the time limit.
 */
export function runTypstSync(job: TypstJob): TypstOutcome {
  const prepared = prepare(job);
  try {
    const result = spawnSync(job.binary, prepared.args, {
      cwd: prepared.root,
      env: prepared.env,
      timeout: job.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const timedOut = (result.error as { code?: string } | undefined)?.code === "ETIMEDOUT";
    return finish(
      prepared,
      {
        timedOut,
        failed: result.error !== undefined || result.status !== 0,
        stderr: result.stderr ?? "",
      },
      job.timeoutMs,
    );
  } finally {
    rmSync(prepared.base, { recursive: true, force: true });
  }
}

/**
 * How many pages a PDF has, from its page tree's `/Count` (the largest, which is the root's), or
 * `undefined` when there is no readable page tree. Typst writes page-tree dictionaries as plain
 * text, so this needs no PDF parser.
 */
export function pdfPageCount(bytes: Uint8Array): number | undefined {
  const text = Buffer.from(bytes).toString("latin1");
  let count: number | undefined;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b([^>]*)/gu)) {
    const value = /\/Count\s+(\d+)/u.exec(match[1] ?? "")?.[1];
    if (value !== undefined) count = Math.max(count ?? 0, Number(value));
  }
  return count;
}
