/**
 * The portability boundary, as an executable rule.
 *
 * The design's gate is that the same role and tools run in a bare Pi Durable harness and inside Office
 * Hum with equivalent receipts. So this file checks the package boundary (Pi Durable and pi-ai are
 * peers, the Office Hum platform packages are absent, the SDK is the only Office Hum dependency) and
 * checks that the pack is driven only by the injected `DocumentService` — and that the Python worker
 * carries no agent loop, no model client and no general shell.
 *
 * The typed Word tools are held to the same rules: they are `defineTool` registrations over the injected
 * service, they send a fixed program with no arguments interpolated into it, and the adapter that program
 * imports is a document library on the workspace API — no path from a caller anywhere in it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "./lease.js";
import {
  PAPER_INTERPRETER_VARIABLE,
  resolvePaperInterpreter,
  workerEnvironment,
} from "./paper-worker.js";
import { PPTX_TOOL_REGISTRATIONS } from "./pptx-tools.js";
import { paperOfficeToolPack, RUN_DOCUMENT_PYTHON } from "./run-document-python.js";
import { WORD_OPERATIONS, wordInstruction } from "./word-operations.js";
import { WORD_TOOL_REGISTRATIONS } from "./word-tools.js";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
};
const workerSource = readFileSync(new URL("python/worker.py", root), "utf8");
const workspaceSource = readFileSync(new URL("python/officehum_documents.py", root), "utf8");
const adapterSource = readFileSync(new URL("python/word_adapter.py", root), "utf8");
const lock = readFileSync(new URL("requirements.lock", root), "utf8");

describe("the pack's portability boundary", () => {
  it("depends on Pi Durable and pi-ai as peers, never on an Office Hum platform package", () => {
    const runtime = Object.keys({
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.peerDependencies ?? {}),
    });
    expect(runtime.filter((name) => name.startsWith("@officehum/"))).toEqual(["@officehum/sdk"]);
    expect(packageJson.peerDependencies?.["@earendil-works/pi-durable"]).toBe("1.3.x");
    expect(packageJson.peerDependencies?.["@earendil-works/pi-ai"]).toBe("1.3.x");
    expect(runtime).not.toContain("@officehum/office");
    expect(runtime).not.toContain("@officehum/cli");
  });

  it("ships the worker script and the lock with the package", () => {
    expect(packageJson.files).toContain("python");
    expect(packageJson.files).toContain("requirements.lock");
  });

  it("pins exactly the three Paper forks the issue names", () => {
    expect(lock).toContain("paper-docx==0.2.0");
    expect(lock).toContain("paper-pptx==0.2.0");
    expect(lock).toContain("paper-xlsx==0.2.1");
    expect(lock).not.toMatch(/^python-docx==/mu);
    expect(lock).not.toMatch(/^python-pptx==/mu);
    expect(lock).not.toMatch(/^openpyxl==/mu);
  });

  it("runs against any injected DocumentService, so a bare harness can supply its own", async () => {
    const lease = {
      leaseId: "lease:1",
      taskId: "task:1",
      inputs: [],
      outputFormats: ["docx"] as const,
      limits: DEFAULT_LIMITS,
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    const seen: string[] = [];
    const pack = paperOfficeToolPack({
      service: {
        async runDocumentPython(request) {
          seen.push(request.operationId);
          return {
            kind: "refused",
            operationId: request.operationId,
            code: "worker-refused",
            message: "a bare-harness fake",
          };
        },
      },
      leaseFor: async () => ({ ...lease, outputFormats: ["docx"] }),
    });
    const tool = pack.tools[0] as unknown as {
      execute(
        args: { code: string },
        api: { taskId: string; conversationId: string; callId: string },
      ): Promise<unknown>;
    };
    const result = (await tool.execute(
      { code: "documents.result(1)" },
      { taskId: "task:1", conversationId: "conv", callId: "call" },
    )) as { isError?: boolean };
    expect(seen).toEqual(["conv:call"]);
    expect(result.isError).toBe(true);
    expect(pack.id).toBe("paper-office");
    expect(pack.tools.map((item) => item.name)).toEqual([
      RUN_DOCUMENT_PYTHON,
      ...WORD_TOOL_REGISTRATIONS,
      ...PPTX_TOOL_REGISTRATIONS,
    ]);
    expect(pack.tools[0]?.name).toBe(RUN_DOCUMENT_PYTHON);
  });

  it("drives the typed Word tools only through whatever service it was handed", async () => {
    const seen: string[] = [];
    const pack = paperOfficeToolPack({
      service: {
        async runDocumentPython(request) {
          seen.push(
            `${request.operationId}:${request.code.includes("word_adapter") ? "word" : "python"}`,
          );
          return {
            kind: "refused",
            operationId: request.operationId,
            code: "worker-refused",
            message: "a bare-harness fake",
          };
        },
      },
      leaseFor: async () => ({
        leaseId: "lease:1",
        taskId: "task:1",
        inputs: [],
        outputFormats: ["docx"],
        limits: DEFAULT_LIMITS,
        expiresAt: "2999-01-01T00:00:00.000Z",
      }),
    });
    const tools = pack.tools as unknown as {
      name: string;
      execute(args: unknown, api: unknown): Promise<{ isError?: boolean }>;
    }[];
    const create = tools.find((tool) => tool.name === "create_document");
    const result = await create?.execute(
      { output: "draft.docx", blocks: [{ kind: "paragraph", text: "Hello." }] },
      { taskId: "task:1", conversationId: "conv", callId: "call" },
    );
    expect(result?.isError).toBe(true);
    expect(seen).toEqual(["conv:call:word"]);
  });

  it("sends a fixed program per operation, with nothing interpolated into it", () => {
    for (const operation of WORD_OPERATIONS) {
      const code = wordInstruction(operation);
      // The only variable in a program is the operation's own name; no argument is ever spliced in.
      expect(code).toMatch(
        /^import word_adapter\n\ndocuments\.result\(word_adapter\.run\("[a-z]+", documents\.arguments\(\)\)\)$/u,
      );
      expect(code).not.toContain("$");
    }
  });
});

describe("the worker's own boundary", () => {
  it("takes its interpreter from the configured path or environment variable", () => {
    expect(resolvePaperInterpreter({}, "/opt/python/bin/python")).toBe("/opt/python/bin/python");
    expect(resolvePaperInterpreter({ [PAPER_INTERPRETER_VARIABLE]: "/opt/py" })).toBe("/opt/py");
    expect(resolvePaperInterpreter({})).toBeUndefined();
    expect(resolvePaperInterpreter({ [PAPER_INTERPRETER_VARIABLE]: "" })).toBeUndefined();
  });

  it("builds the interpreter's environment from scratch, with no credential and no HOME", () => {
    const { env, removed } = workerEnvironment("/tmp/run-1", {
      HOME: "/Users/someone",
      PAPERINSTRUMENTS_API_KEY: "sk-live-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DEPLOY_TOKEN: "token",
      TZ: "UTC",
    });
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.HOME).toBeUndefined();
    expect(env.PAPERINSTRUMENTS_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.TZ).toBe("UTC");
    expect([...removed].sort()).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "DEPLOY_TOKEN",
      "HOME",
      "PAPERINSTRUMENTS_API_KEY",
    ]);
    expect(env.TMPDIR).toBe("/tmp/run-1/tmp");
  });

  it("has no agent loop, no model client and no general shell", () => {
    for (const forbidden of [
      "openai",
      "anthropic",
      "requests",
      "httpx",
      "aiohttp",
      "urllib.request",
      "socket.socket(",
      "PAPERINSTRUMENTS_API_KEY",
    ]) {
      expect(workerSource).not.toContain(forbidden);
      expect(workspaceSource).not.toContain(forbidden);
    }
    // The one network path a submission could try is closed by the import guard and the socket patch.
    expect(workerSource).toContain("network access is not available in the document workspace");
    expect(workerSource).toContain("document code cannot start a process or a shell");
    expect(workerSource).toContain("block_network");
    expect(workerSource).toContain("DENIED_IMPORTS");
  });

  it("verifies the three sentinels before it runs any submitted code", () => {
    const sentinelAt = workerSource.indexOf("def check_sentinels");
    const submittedAt = workerSource.indexOf("exec(code");
    expect(sentinelAt).toBeGreaterThan(0);
    expect(submittedAt).toBeGreaterThan(sentinelAt);
    for (const doctor of ["paper_docx_doctor", "paper_pptx_doctor", "paper_xlsx_doctor"]) {
      expect(workerSource).toContain(doctor);
    }
  });

  it("lets submitted code import the adapter, and nothing wider", () => {
    expect(workerSource).toContain('"word_adapter",');
    for (const forbidden of [
      "requests",
      "urllib",
      "socket",
      "subprocess",
      "openai",
      "http.client",
      "sys.argv",
      "os.environ",
      "api_key",
    ]) {
      expect(adapterSource).not.toContain(forbidden);
    }
    // No operation reads a path, a URL or a credential out of its parameters.
    expect(adapterSource).not.toContain('params["path"]');
    expect(adapterSource).not.toContain('entry["path"]');
    expect(adapterSource).not.toContain("https://");
    expect(adapterSource).toContain("documents.open_input");
    expect(adapterSource).toContain("documents.declare_output");
  });

  it("does not depend on the container profile it still needs", () => {
    // RASF-3111 is Backlog: the code must say so rather than imply isolation it has not enforced.
    expect(workerSource).toContain("RASF-3111");
    expect(workspaceSource).toContain("worker");
  });

  it("offers a workspace API of version IDs and declared outputs, with no path entry point", () => {
    const exported = workspaceSource.split("__all__ = [")[1]?.split("]")[0] ?? "";
    expect(exported).toContain("open_input");
    expect(exported).toContain("declare_output");
    expect(exported).not.toContain("open_path");
    expect(exported).not.toContain("mount");
    expect(exported).not.toContain("shell");
    expect(workspaceSource).toContain("lease does not grant");
    expect(workspaceSource).toContain("a lease grants no directory");
  });
});
