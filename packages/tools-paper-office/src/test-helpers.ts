/**
 * Test scaffolding: a ZIP writer, OOXML package builders, a recording fake worker and interpreter
 * discovery. Kept out of the package build (see `tsconfig.json`), typechecked by `tsconfig.test.json`.
 *
 * The fake worker lets the durable lifecycle — replay, crash, resume, lineage, refuse — be tested
 * without a Python interpreter, so those tests always run. The interpreter-backed tests skip *visibly*
 * when no interpreter is configured, rather than guessing at a path.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type {
  DeclaredOutput,
  PaperWorker,
  PaperWorkerOutcome,
  PaperWorkerRequest,
} from "./paper-worker.js";
import { defaultWorkerScript, resolvePaperInterpreter } from "./paper-worker.js";

/** The interpreter the host configured, or `undefined` when there is none. */
export function configuredInterpreter(): string | undefined {
  return resolvePaperInterpreter(process.env);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export interface ZipEntry {
  readonly name: string;
  readonly data: string | Uint8Array;
  /** Default `deflate`; `store` keeps the bytes verbatim. */
  readonly method?: "store" | "deflate";
  /** Overrides the size the central directory declares, for a zip-bomb fixture. */
  readonly declaredUncompressed?: number;
  readonly declaredCompressed?: number;
}

interface Prepared {
  readonly name: Uint8Array;
  readonly stored: Uint8Array;
  readonly method: number;
  readonly crc: number;
  readonly compressed: number;
  readonly uncompressed: number;
  readonly declaredCompressed: number;
  readonly declaredUncompressed: number;
}

/**
 * A minimal ZIP writer, enough for a real Office package: local headers, a central directory and an
 * EOCD. The declared sizes can be overridden so a test can build a package that *claims* to expand
 * far beyond what it holds.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const prepared: Prepared[] = entries.map((entry) => {
    const data = typeof entry.data === "string" ? utf8(entry.data) : entry.data;
    const method = (entry.method ?? "deflate") === "store" ? 0 : 8;
    const stored = method === 8 ? Uint8Array.from(deflateRawSync(data)) : data;
    return {
      name: utf8(entry.name),
      stored,
      method,
      crc: crc32(data),
      compressed: stored.byteLength,
      uncompressed: data.byteLength,
      declaredCompressed: entry.declaredCompressed ?? stored.byteLength,
      declaredUncompressed: entry.declaredUncompressed ?? data.byteLength,
    };
  });

  const locals: Uint8Array[] = [];
  const offsetOf: number[] = [];
  let offset = 0;
  for (const entry of prepared) {
    offsetOf.push(offset);
    const header = new Uint8Array(30 + entry.name.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entry.method, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.declaredCompressed, true);
    view.setUint32(22, entry.declaredUncompressed, true);
    view.setUint16(26, entry.name.byteLength, true);
    header.set(entry.name, 30);
    locals.push(header, entry.stored);
    offset += header.byteLength + entry.stored.byteLength;
  }

  const directory = new Uint8Array(
    prepared.reduce((total, entry) => total + 46 + entry.name.byteLength, 0),
  );
  let cursor = 0;
  prepared.forEach((entry, index) => {
    const view = new DataView(directory.buffer, cursor, 46);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, entry.method, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.declaredCompressed, true);
    view.setUint32(24, entry.declaredUncompressed, true);
    view.setUint16(28, entry.name.byteLength, true);
    view.setUint32(42, offsetOf[index] ?? 0, true);
    directory.set(entry.name, cursor + 46);
    cursor += 46 + entry.name.byteLength;
  });

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, prepared.length, true);
  eocdView.setUint16(10, prepared.length, true);
  eocdView.setUint32(12, directory.byteLength, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...locals, directory, eocd];
  const total = parts.reduce((size, part) => size + part.byteLength, 0);
  const out = new Uint8Array(total);
  let write = 0;
  for (const part of parts) {
    out.set(part, write);
    write += part.byteLength;
  }
  return out;
}

const CONTENT_TYPES = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/word/document.xml"',
  ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  "</Types>",
].join("");

function relationships(targets: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...targets.map(
      (target, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="${target}"/>`,
    ),
    "</Relationships>",
  ].join("");
}

/** A structurally valid Word package with internal relationships only. */
export function docxPackage(): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "word/document.xml", data: '<w:document xmlns:w="w"><w:body/></w:document>' },
    {
      name: "word/_rels/document.xml.rels",
      data: relationships(["styles.xml", "../docProps/core.xml"]),
    },
    { name: "docProps/core.xml", data: "<core/>" },
  ]);
}

export function xlsxPackage(): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "xl/workbook.xml", data: "<workbook/>" },
    { name: "xl/_rels/workbook.xml.rels", data: relationships(["worksheets/sheet1.xml"]) },
    { name: "xl/worksheets/sheet1.xml", data: "<worksheet/>" },
  ]);
}

export interface PackageOverrides {
  readonly targets?: readonly string[];
  readonly external?: readonly string[];
  readonly extra?: readonly ZipEntry[];
  readonly omitContentTypes?: boolean;
  readonly entries?: readonly ZipEntry[];
}

/** A docx-shaped package a test can make hostile in one specific way. */
export function docxLike(overrides: PackageOverrides = {}): Uint8Array {
  if (overrides.entries !== undefined) return buildZip(overrides.entries);
  const parts: ZipEntry[] = [];
  if (overrides.omitContentTypes !== true) {
    parts.push({ name: "[Content_Types].xml", data: CONTENT_TYPES });
  }
  parts.push({ name: "word/document.xml", data: '<w:document xmlns:w="w"><w:body/></w:document>' });
  const rels = [
    ...(overrides.targets ?? ["styles.xml"]).map(
      (target) => `<Relationship Id="rId${target.length}" Type="t" Target="${target}"/>`,
    ),
    ...(overrides.external ?? []).map(
      (target) =>
        `<Relationship Id="r${target.length}" Type="t" Target="${target}" TargetMode="External"/>`,
    ),
  ];
  parts.push({
    name: "word/_rels/document.xml.rels",
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      ...rels,
      "</Relationships>",
    ].join(""),
  });
  parts.push(...(overrides.extra ?? []));
  return buildZip(parts);
}

export interface RecordingWorker extends PaperWorker {
  readonly calls: PaperWorkerRequest[];
}

export interface FakeWorkerOptions {
  /** The leased version IDs the scripted run reports having read. */
  readonly reads?: readonly string[];
  readonly result?: unknown;
  readonly resultDeclared?: boolean;
  readonly notes?: readonly string[];
}

function scriptedEvidence(outputs: readonly DeclaredOutput[], options: FakeWorkerOptions) {
  return {
    identity: {
      python: "3.13.17",
      image: "paper-worker:python-3.13",
      libraries: {
        python: "3.13.17",
        "paper-docx": "0.2.0",
        "paper-pptx": "0.2.0",
        "paper-xlsx": "0.2.1",
      },
      modules: { docx: "1.2.0", pptx: "1.0.2", openpyxl: "3.1.5" },
    },
    reads: [...(options.reads ?? [])],
    reopen: outputs.map((output) => `${output.name}: 1 section`),
    enforcement: { worker: "subprocess", network: "python-socket-guard" },
    notes: [...(options.notes ?? [])],
    stdout: "",
    result: options.result ?? { scripted: true },
    resultDeclared: options.resultDeclared ?? true,
  };
}

/** A worker that answers with scripted outputs and counts its invocations. */
export function fakeWorker(
  outputs: readonly DeclaredOutput[],
  options: FakeWorkerOptions = {},
): RecordingWorker {
  const calls: PaperWorkerRequest[] = [];
  return {
    calls,
    async run(request): Promise<PaperWorkerOutcome> {
      calls.push(request);
      return { kind: "completed", outputs, evidence: scriptedEvidence(outputs, options) };
    },
  };
}

/** A worker that answers differently on each call, for a "different bytes on the replay" fixture. */
export function sequenceWorker(
  answers: readonly (readonly DeclaredOutput[])[],
  options: FakeWorkerOptions = {},
): RecordingWorker {
  const calls: PaperWorkerRequest[] = [];
  return {
    calls,
    async run(request): Promise<PaperWorkerOutcome> {
      const index = calls.length;
      calls.push(request);
      const outputs = answers[index] ?? answers[answers.length - 1] ?? [];
      return { kind: "completed", outputs, evidence: scriptedEvidence(outputs, options) };
    },
  };
}

/** A worker that refuses every run, for the "refusal leaves the sources untouched" tests. */
export function refusingWorker(code: "symlink" | "network", message: string): RecordingWorker {
  const calls: PaperWorkerRequest[] = [];
  return {
    calls,
    async run(request): Promise<PaperWorkerOutcome> {
      calls.push(request);
      return { kind: "refused", code, message };
    },
  };
}

/** A worker that throws, standing in for a crash while staging. */
export function crashingWorker(error: Error): RecordingWorker {
  const calls: PaperWorkerRequest[] = [];
  return {
    calls,
    async run(request): Promise<PaperWorkerOutcome> {
      calls.push(request);
      throw error;
    },
  };
}

export function declaredOutput(
  name: string,
  format: DeclaredOutput["format"],
  bytes: Uint8Array,
  editOf: string | null = null,
): DeclaredOutput {
  return { name, format, size: bytes.byteLength, sha256: sha256(bytes), editOf, bytes };
}

/** Whether a scripted `python -c` run against an interpreter exits zero, with its output. */
export function runPython(
  interpreter: string,
  args: readonly string[],
  options: { readonly env?: Record<string, string>; readonly cwd?: string } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      interpreter,
      [...args],
      {
        env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", ...options.env },
        cwd: options.cwd,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const status = (error as { code?: number } | null)?.code;
        resolve({
          code: error ? (typeof status === "number" ? status : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** The three sentinels, as a one-shot check a test can make against a configured interpreter. */
export async function sentinelReport(
  interpreter: string,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const script = [
    "import importlib, sys",
    "out = []",
    "for name in ('paper_docx_doctor','paper_pptx_doctor','paper_xlsx_doctor'):",
    "    try:",
    "        module = importlib.import_module(name)",
    "        out.append(name + '=' + str(module.verify_install()))",
    "    except Exception as error:",
    "        out.append(name + '=FAIL:' + type(error).__name__)",
    "print(';'.join(out))",
  ].join("\n");
  const answer = await runPython(interpreter, ["-c", script]);
  return { ok: answer.code === 0 && !answer.stdout.includes("FAIL"), detail: answer.stdout.trim() };
}

export function workerScriptPath(): string {
  return defaultWorkerScript();
}

/**
 * A real Word fixture, built through the worker so it comes from the pinned library rather than a
 * hand-written archive: headings, paragraphs, a two-by-two table, a header and a footer, an anchored
 * comment and a tracked insertion.
 *
 * `awkward` makes one *untouched* part byte-different from what a re-serialization would emit — the
 * XML declaration of `word/styles.xml` loses `standalone="yes"` — so a test can prove the part came
 * back verbatim instead of being rewritten.
 */
export interface WordFixtureOptions {
  readonly awkward?: boolean;
  /** Turn Restrict Editing on, so a test can check that an edit of a locked document refuses. */
  readonly protected?: boolean;
  readonly name?: string;
}

export function wordFixtureCode(options: WordFixtureOptions = {}): string {
  const lines = [
    "import docx, zipfile",
    "import docx.blocks",
    "",
    "document = docx.Document()",
    "document.add_heading('Quarterly Close', level=1)",
    "document.add_paragraph('Draft prepared by the office.')",
    "document.add_heading('Revenue', level=2)",
    "figure = document.add_paragraph('Revenue was 1250 dollars.')",
    "table = document.add_table(rows=2, cols=2)",
    "for row, values in enumerate([['Account', 'Amount'], ['Revenue', '1250']]):",
    "    for column, value in enumerate(values):",
    "        table.cell(row, column).text = value",
    "document.sections[0].header.paragraphs[0].text = 'Office Hum - internal'",
    "document.sections[0].footer.paragraphs[0].text = 'Page footer'",
    "document.add_comment(",
    "    [figure.runs[0]], text='Please confirm this figure.', author='Reviewer'",
    ")",
    "docx.blocks.insert_section_after(",
    "    document, 'Draft prepared by the office.', heading='Notes',",
    "    paragraphs=['Initial review'], author='Reviewer', tracked=True,",
    ")",
  ];
  if (options.protected === true) {
    lines.push(
      "import docx.protection",
      "docx.protection.set_protection(document, edit='readOnly')",
    );
  }
  lines.push(
    `path = documents.declare_output(${JSON.stringify(options.name ?? "brief.docx")}, "docx")`,
  );
  lines.push("document.save(path)");
  if (options.awkward === true) {
    lines.push(
      "# One untouched part, byte-different from what a re-serialization would emit.",
      "with zipfile.ZipFile(path) as source:",
      "    entries = [(item, source.read(item.filename)) for item in source.infolist()]",
      "with zipfile.ZipFile(path, 'w') as target:",
      "    for item, data in entries:",
      "        if item.filename == 'word/styles.xml':",
      "            data = data.replace(b' standalone=\"yes\"', b'')",
      "        target.writestr(item, data)",
    );
  }
  lines.push(
    "documents.result({",
    "    'paragraphs': len(docx.Document(path).paragraphs),",
    "    'comments': len(docx.Document(path).comments),",
    "})",
  );
  return lines.join("\n");
}

/**
 * The parts of a ZIP archive, by name, extracted. Enough for a test to compare an untouched part's
 * bytes between a source document and the proposal an edit produced — the evidence that preservation is
 * real rather than plausible.
 */
export function zipEntries(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const floor = Math.max(0, bytes.byteLength - 22 - 65_535);
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("malformed central directory");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? Uint8Array.from(raw) : Uint8Array.from(inflateRawSync(raw)));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface DirectWorkerRequest {
  readonly operationId: string;
  readonly code: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly inputs?: readonly {
    readonly name: string;
    readonly format: string;
    readonly bytes: Uint8Array;
    readonly sha256?: string;
  }[];
  readonly outputFormats?: readonly string[];
  readonly limits?: Readonly<Record<string, number>>;
}

export interface DirectWorkerAnswer {
  readonly exitCode: number;
  readonly json: Record<string, unknown>;
  readonly staging: readonly string[];
}

/**
 * Hands the checked-in worker script a request directly, so a test can exercise a gate the host's own
 * client would otherwise stop first — the worker's input hash check, for instance. This writes the
 * request and the staged inputs itself and spawns the interpreter, exactly as a host would.
 */
export async function invokeWorker(
  interpreter: string,
  request: DirectWorkerRequest,
): Promise<DirectWorkerAnswer> {
  const { mkdir, mkdtemp, readdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const runDir = await mkdtemp(join(tmpdir(), "paper-direct-"));
  try {
    const inputsDir = join(runDir, "inputs");
    const staging = join(runDir, "staging");
    await mkdir(inputsDir);
    await mkdir(staging);
    await mkdir(join(runDir, "tmp"));
    const inputs = [];
    for (const input of request.inputs ?? []) {
      await writeFile(join(inputsDir, input.name), input.bytes, { flag: "wx", mode: 0o600 });
      inputs.push({
        versionId: `file_${"A".repeat(26)}`,
        fileId: `file_${"A".repeat(26)}`,
        name: input.name,
        format: input.format,
        sha256: input.sha256 ?? sha256(input.bytes),
        size: input.bytes.byteLength,
        writable: true,
      });
    }
    const requestPath = join(runDir, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        protocol: "officehum.paper-worker/1",
        operationId: request.operationId,
        code: request.code,
        arguments: request.arguments ?? {},
        libraries: { "paper-docx": "0.2.0", "paper-pptx": "0.2.0", "paper-xlsx": "0.2.1" },
        inputs,
        inputsDir,
        staging,
        outputFormats: [...(request.outputFormats ?? ["docx"])],
        limits: {
          cpuSeconds: 20,
          memoryBytes: 1_024 * 1_024 * 1_024,
          wallSeconds: 20,
          outputBytes: 8 * 1_024 * 1_024,
          fileCount: 4,
          archiveBytes: 64 * 1_024 * 1_024,
          archiveEntries: 4_096,
          archiveRatio: 200,
          ...(request.limits ?? {}),
        },
      }),
      { flag: "wx", mode: 0o600 },
    );
    const answer = await runPython(interpreter, [defaultWorkerScript(), "--request", requestPath], {
      cwd: staging,
      env: { TMPDIR: join(runDir, "tmp"), PYTHONHASHSEED: "0" },
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(answer.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
    } catch {
      json = { code: "no-json", raw: answer.stdout.slice(0, 200) };
    }
    const stagingEntries = await readdir(staging).catch(() => []);
    return { exitCode: answer.code, json, staging: stagingEntries };
  } finally {
    const { chmod } = await import("node:fs/promises");
    await chmod(join(runDir, "inputs"), 0o700).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true });
  }
}
