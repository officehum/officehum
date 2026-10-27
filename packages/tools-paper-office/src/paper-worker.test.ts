/**
 * The sandbox and limit tests, against a real Python 3.13 interpreter.
 *
 * These skip **visibly** when no interpreter is configured (`OFFICEHUM_PAPER_PYTHON`), because the
 * worker must take its interpreter from a configured path and there is no safe guess. Everything that
 * can be tested without an interpreter — the package inspection, the lease, the durable lifecycle —
 * lives in the other test files and always runs.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type ResourceLimits } from "./lease.js";
import type { PaperWorkerOutcome } from "./paper-worker.js";
import { subprocessPaperWorker } from "./paper-worker.js";
import {
  configuredInterpreter,
  invokeWorker,
  runPython,
  sentinelReport,
  sha256,
} from "./test-helpers.js";

const interpreter = configuredInterpreter();
const suite = interpreter === undefined ? describe.skip : describe;

const pythonDir = fileURLToPath(new URL("../python", import.meta.url));

if (interpreter === undefined) {
  console.warn(
    "paper-worker tests skipped: set OFFICEHUM_PAPER_PYTHON to a Python 3.13 interpreter with " +
      "packages/tools-paper-office/requirements.lock installed (scripts/provision-worker.sh)",
  );
}

const ROOMY: ResourceLimits = {
  ...DEFAULT_LIMITS,
  cpuSeconds: 30,
  wallSeconds: 60,
  outputBytes: 16 * 1024 * 1024,
  fileCount: 4,
  memoryBytes: 1_024 * 1_024 * 1_024,
};

const FILE_A = `file_${"A".repeat(26)}`;

function worker(graceSeconds = 10) {
  return subprocessPaperWorker({ interpreter: interpreter ?? "", graceSeconds });
}

function completed(outcome: PaperWorkerOutcome) {
  if (outcome.kind !== "completed") throw new Error(`expected a run, got ${outcome.code}`);
  return outcome;
}

function refusal(outcome: PaperWorkerOutcome) {
  if (outcome.kind !== "refused") throw new Error("expected a refusal, got a run");
  return outcome;
}

/** Build a real docx with the pinned library, through the worker, for use as a later input. */
async function makeInputDocx(): Promise<Uint8Array> {
  const outcome = completed(
    await worker().run({
      operationId: "fixture:docx",
      code: [
        "import docx",
        "document = docx.Document()",
        "document.add_paragraph('Quarterly close checklist')",
        "document.save(documents.declare_output('brief.docx', 'docx'))",
        "documents.result({'paragraphs': len(document.paragraphs)})",
      ].join("\n"),
      arguments: {},
      inputs: [],
      outputFormats: ["docx"],
      limits: ROOMY,
    }),
  );
  const output = outcome.outputs[0];
  if (output === undefined) throw new Error("the fixture worker produced no document");
  return output.bytes;
}

function inputOf(name: string, format: "docx", bytes: Uint8Array) {
  return {
    fileId: FILE_A,
    versionId: FILE_A,
    name,
    format,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    writable: true,
    bytes,
  };
}

suite("the isolated document worker", () => {
  it("verifies the three Paper sentinels in the configured interpreter", async () => {
    const report = await sentinelReport(interpreter ?? "");
    expect(report.detail).toContain("paper_docx_doctor=0.2.0");
    expect(report.detail).toContain("paper_pptx_doctor=0.2.0");
    expect(report.detail).toContain("paper_xlsx_doctor=0.2.1");
    expect(report.ok).toBe(true);
  });

  it("runs all three libraries, saves, reads back and reports its verified identity", async () => {
    const outcome = completed(
      await worker().run({
        operationId: "all-three",
        code: [
          "import docx, openpyxl, pptx",
          "report = docx.Document()",
          "report.add_paragraph('Reviewed')",
          "report.save(documents.declare_output('report.docx', 'docx'))",
          "deck = pptx.Presentation()",
          "slide = deck.slides.add_slide(deck.slide_layouts[0])",
          "slide.shapes.title.text = 'Close'",
          "deck.save(documents.declare_output('deck.pptx', 'pptx'))",
          "book = openpyxl.Workbook()",
          "book.active['A1'] = 41",
          "book.active['A2'] = '=A1+1'",
          "book.save(documents.declare_output('book.xlsx', 'xlsx'))",
          "back = docx.Document(documents.open_input('report.docx')) if False else None",
          "documents.result({",
          "  'docx': len(docx.Document(documents.staging() + '/report.docx').paragraphs),",
          "  'pptx': len(pptx.Presentation(documents.staging() + '/deck.pptx').slides),",
          "  'xlsx': len(openpyxl.load_workbook(documents.staging() + '/book.xlsx').sheetnames),",
          "})",
        ].join("\n"),
        arguments: {},
        inputs: [],
        outputFormats: ["docx", "pptx", "xlsx"],
        limits: ROOMY,
      }),
    );

    expect(outcome.outputs.map((output) => output.name).sort()).toEqual([
      "book.xlsx",
      "deck.pptx",
      "report.docx",
    ]);
    expect(outcome.evidence.result).toEqual({ docx: 1, pptx: 1, xlsx: 1 });
    expect(outcome.evidence.reopen).toEqual([
      "report.docx: 1 paragraphs",
      "deck.pptx: 1 slides",
      "book.xlsx: 1 sheets",
    ]);
    expect(outcome.evidence.identity.libraries.python).toMatch(/^3\.13\./);
    // The patch level of the interpreter is deliberately not pinned: `uv` resolves the newest 3.13,
    // and a test that names today's patch turns a routine upstream release into a red build. What
    // the contract requires is a 3.13 interpreter with exactly these three forks owning their module
    // names.
    expect(outcome.evidence.identity.libraries.python).toMatch(/^3\.13\./);
    expect(outcome.evidence.identity.libraries).toMatchObject({
      "paper-docx": "0.2.0",
      "paper-pptx": "0.2.0",
      "paper-xlsx": "0.2.1",
    });
    expect(outcome.evidence.identity.modules).toMatchObject({
      docx: "1.2.0",
      pptx: "1.0.2",
      openpyxl: "3.1.5",
    });
    expect(outcome.evidence.enforcement.limits).toMatchObject({ cpu: true, fileSize: true });
  });

  it("reads a leased version, edits it and reports the version it read", async () => {
    const source = await makeInputDocx();
    const outcome = completed(
      await worker().run({
        operationId: "edit-input",
        code: [
          "import docx",
          "document = docx.Document(documents.open_input('brief.docx'))",
          "document.add_paragraph('Signed off')",
          "document.save(documents.declare_output('brief.docx', 'docx', edit_of='brief.docx'))",
          "documents.result({'paragraphs': len(documents.inputs())})",
        ].join("\n"),
        arguments: {},
        inputs: [inputOf("brief.docx", "docx", source)],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(outcome.evidence.reads).toEqual([FILE_A]);
    expect(outcome.outputs[0]?.editOf).toBe(FILE_A);
    expect(outcome.outputs[0]?.sha256).not.toBe(sha256(source));
    expect(outcome.evidence.result).toEqual({ paragraphs: 1 });
  });

  it("refuses a network call", async () => {
    const viaImport = refusal(
      await worker().run({
        operationId: "net-import",
        code: "import socket\nsocket.socket()",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(viaImport.code).toBe("network");

    const viaConnect = refusal(
      await worker().run({
        operationId: "net-connect",
        code: "import socket\nsocket.create_connection(('1.1.1.1', 80))",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(viaConnect.code).toBe("network");

    const viaCtypes = refusal(
      await worker().run({
        operationId: "net-ctypes",
        code: "import ctypes\nctypes.CDLL(None).socket",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(viaCtypes.code).toBe("process");
  });

  it("blocks socket construction even for a reference a library smuggled out", async () => {
    const script = [
      "import socket, sys",
      "sys.path.insert(0, '.')",
      "import worker",
      "worker.block_network()",
      "try:",
      "    socket.socket()",
      "except Exception as error:",
      "    print('blocked', type(error).__name__)",
      "else:",
      "    print('NOT BLOCKED')",
    ].join("\n");
    const answer = await runPython(interpreter ?? "", ["-c", script], { cwd: pythonDir });
    expect(answer.stdout.trim()).toBe("blocked Refusal");
  });

  it("blocks the shell and keeps the credential out of the interpreter's environment", async () => {
    process.env.PAPERINSTRUMENTS_API_KEY = "sk-live-should-not-leak";
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-leak";
    try {
      const outcome = completed(
        await worker().run({
          operationId: "credentials",
          code: [
            "environment = documents.environment()",
            "documents.result({",
            "  'keys': sorted(environment.keys()),",
            "  'path': environment.get('PATH'),",
            "  'home': environment.get('HOME'),",
            "  'secret': environment.get('PAPERINSTRUMENTS_API_KEY'),",
            "})",
          ].join("\n"),
          arguments: {},
          inputs: [],
          outputFormats: ["docx"],
          limits: ROOMY,
        }),
      );
      const result = outcome.evidence.result as {
        keys: string[];
        path: string;
        home: string | null;
        secret: string | null;
      };
      expect(result.path).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(result.home).toBeNull();
      expect(result.secret).toBeNull();
      expect(result.keys).not.toContain("PAPERINSTRUMENTS_API_KEY");
      expect(result.keys).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(outcome.evidence.notes.join(" ")).toContain("filesystem confinement are Python-level");
    } finally {
      delete process.env.PAPERINSTRUMENTS_API_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }

    const shell = refusal(
      await worker().run({
        operationId: "shell",
        code: "import subprocess",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(shell.code).toBe("process");

    const systemCall = refusal(
      await worker().run({
        operationId: "os-system",
        code: "import os\nos.system('touch /tmp/should-not-exist')",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(systemCall.code).toBe("invalid-request");
  });

  it("refuses a path outside the lease, including one that is a well-formed file ID", async () => {
    const source = await makeInputDocx();
    for (const reference of ["/etc/passwd", `file_${"Z".repeat(26)}`, "../../etc/hosts"]) {
      const outcome = refusal(
        await worker().run({
          operationId: "unleased",
          code: `documents.open_input(${JSON.stringify(reference)})`,
          arguments: {},
          inputs: [inputOf("brief.docx", "docx", source)],
          outputFormats: ["docx"],
          limits: ROOMY,
        }),
      );
      expect(outcome.code).toBe("ungranted-input");
    }
  });

  it("refuses a staging entry that is a symbolic link", async () => {
    const outcome = refusal(
      await worker().run({
        operationId: "symlink",
        code: [
          "import pathlib",
          "path = documents.declare_output('link.docx', 'docx')",
          "pathlib.Path(path).write_bytes(b'placeholder')",
          "pathlib.Path(path).unlink()",
          "pathlib.Path(path).symlink_to('/etc/passwd')",
        ].join("\n"),
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(outcome.code).toBe("symlink");
  });

  it("refuses a traversal name and an undeclared file effect", async () => {
    const traversal = refusal(
      await worker().run({
        operationId: "traversal",
        code: "documents.declare_output('../escape.docx', 'docx')",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(traversal.code).toBe("traversal");

    const undeclared = refusal(
      await worker().run({
        operationId: "undeclared",
        code: [
          "import docx",
          "document = docx.Document()",
          "document.save(documents.staging() + '/sneak.docx')",
        ].join("\n"),
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(undeclared.code).toBe("undeclared-output");

    const missing = refusal(
      await worker().run({
        operationId: "missing",
        code: "documents.declare_output('never.docx', 'docx')",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(missing.code).toBe("missing-output");
  });

  it("refuses an oversized output and too many files", async () => {
    const oversized = refusal(
      await worker().run({
        operationId: "oversized",
        code: [
          "import random",
          "documents.write_output('big.docx', random.Random(1).randbytes(200000))",
        ].join("\n"),
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: { ...ROOMY, outputBytes: 100_000 },
      }),
    );
    expect(["output-bytes", "file-size-limit"]).toContain(oversized.code);

    const tooMany = refusal(
      await worker().run({
        operationId: "too-many",
        code: [
          "import docx",
          "for name in ('a.docx', 'b.docx', 'c.docx'):",
          "    document = docx.Document()",
          "    document.save(documents.declare_output(name, 'docx'))",
        ].join("\n"),
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: { ...ROOMY, fileCount: 2 },
      }),
    );
    expect(tooMany.code).toBe("file-count");
  });

  it("kills a run over its wall-clock budget", async () => {
    const outcome = refusal(
      await worker(5).run({
        operationId: "timeout",
        code: "import time\ntime.sleep(60)",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: { ...ROOMY, wallSeconds: 1 },
      }),
    );
    expect(outcome.code).toBe("timeout");
  });

  it("kills a run over its CPU budget", async () => {
    const outcome = refusal(
      await worker().run({
        operationId: "cpu",
        code: "total = 0\nwhile True:\n    total += 1",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: { ...ROOMY, cpuSeconds: 1, wallSeconds: 30 },
      }),
    );
    expect(["cpu-limit", "timeout", "resource-limit"]).toContain(outcome.code);
  });

  it("applies the memory limit where the platform allows it, and says so where it does not", async () => {
    const probe = completed(
      await worker().run({
        operationId: "memory-probe",
        code: "documents.result(len(documents.inputs()))",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: { ...ROOMY, memoryBytes: 256 * 1024 * 1024 },
      }),
    );
    const limits = probe.evidence.enforcement.limits as Record<string, boolean>;
    if (limits.memory === true) {
      const outcome = refusal(
        await worker().run({
          operationId: "memory",
          code: "empty = bytearray(900 * 1024 * 1024)\ndocuments.result(len(empty))",
          arguments: {},
          inputs: [],
          outputFormats: ["docx"],
          limits: { ...ROOMY, memoryBytes: 256 * 1024 * 1024 },
        }),
      );
      expect(["memory-limit", "code-error", "resource-limit"]).toContain(outcome.code);
    } else {
      expect(probe.evidence.notes.join(" ")).toContain("memory limit is not enforced");
      expect(limits.memory).toBe(false);
    }
  });

  it("refuses a run that modifies its leased input", async () => {
    const source = await makeInputDocx();
    const outcome = refusal(
      await worker().run({
        operationId: "source-tamper",
        code: [
          "import pathlib",
          "path = documents.open_input('brief.docx')",
          "pathlib.Path(path).chmod(0o600)",
          "pathlib.Path(path).write_bytes(b'tampered')",
          "documents.result('wrote')",
        ].join("\n"),
        arguments: {},
        inputs: [inputOf("brief.docx", "docx", source)],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(outcome.code).toBe("source-integrity");
  });

  it("refuses an output that the pinned library cannot reopen", async () => {
    const outcome = refusal(
      await worker().run({
        operationId: "reopen",
        code: "documents.write_output('not-really.docx', b'plain text where a package belongs')",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(outcome.code).toBe("output-invalid");
  });

  it("refuses a syntax error and a raised error as typed refusals", async () => {
    const syntax = refusal(
      await worker().run({
        operationId: "syntax",
        code: "def (:\n",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(syntax.code).toBe("code-syntax");

    const raised = refusal(
      await worker().run({
        operationId: "raised",
        code: "raise ValueError('the brief had no total')",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(raised.code).toBe("code-error");
    expect(raised.message).toContain("ValueError");
  });

  it("refuses a declared output whose format the lease does not permit", async () => {
    const outcome = refusal(
      await worker().run({
        operationId: "wrong-format",
        code: "documents.declare_output('book.xlsx', 'xlsx')",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(outcome.code).toBe("output-format");
  });

  it("captures submitted output so it can never corrupt the worker's JSON answer", async () => {
    const outcome = completed(
      await worker().run({
        operationId: "stdout",
        code: "print('a line the worker must swallow')\ndocuments.result({'ok': True})",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(outcome.evidence.stdout).toContain("a line the worker must swallow");
    expect(outcome.evidence.result).toEqual({ ok: true });
  });

  it("refuses when the configured interpreter is not the pinned worker environment", async () => {
    const bare = "/usr/bin/python3";
    const outcome = refusal(
      await subprocessPaperWorker({ interpreter: bare }).run({
        operationId: "bare",
        code: "documents.result(1)",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect([
      "interpreter-version",
      "doctor-missing",
      "interpreter-missing",
      "worker-refused",
    ]).toContain(outcome.code);
  });

  it("refuses when the interpreter is missing entirely", async () => {
    const outcome = refusal(
      await subprocessPaperWorker({ interpreter: join(pythonDir, "no-such-python") }).run({
        operationId: "missing-interpreter",
        code: "documents.result(1)",
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    expect(["interpreter-missing", "worker-crash"]).toContain(outcome.code);
  });

  it("reports a hash and size for every declared output that match the staged bytes", async () => {
    const outcome = completed(
      await worker().run({
        operationId: "hashes",
        code: [
          "import docx",
          "document = docx.Document()",
          "document.add_paragraph('hashed')",
          "document.save(documents.declare_output('report.docx', 'docx'))",
        ].join("\n"),
        arguments: {},
        inputs: [],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    );
    for (const output of outcome.outputs) {
      expect(output.sha256).toBe(sha256(output.bytes));
      expect(output.size).toBe(output.bytes.byteLength);
    }
  });

  it("refuses to stage an input whose bytes do not match the lease's hash", async () => {
    const source = await makeInputDocx();
    const input = { ...inputOf("brief.docx", "docx", source), sha256: "e".repeat(64) };
    await expect(
      worker().run({
        operationId: "input-integrity-host",
        code: "documents.result(1)",
        arguments: {},
        inputs: [input],
        outputFormats: ["docx"],
        limits: ROOMY,
      }),
    ).rejects.toThrow(/do not match the lease/);
  });

  it("checks a staged input's hash again inside the worker", async () => {
    const source = await makeInputDocx();
    const answer = await invokeWorker(interpreter ?? "", {
      operationId: "input-integrity-worker",
      code: "documents.result(1)",
      inputs: [{ name: "brief.docx", format: "docx", bytes: source, sha256: "f".repeat(64) }],
      outputFormats: ["docx"],
    });
    expect(answer.json.code).toBe("input-integrity");
    expect(answer.staging).toEqual([]);
  });
});
