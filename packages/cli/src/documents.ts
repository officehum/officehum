/**
 * Giving a role the Paper Office document tools in `officehum runtime` (RASF-3577).
 *
 * A role's office-file entry may name the document formats it may produce. For such a role this
 * module builds the local document service — the office's versioned file store, the provisioned
 * Python worker, a run ledger — and adds one extension to the role's bundle: the typed tools for
 * those formats, and a prompt section saying what they are for. The role package is not touched, so
 * the same role runs unchanged in an office that grants it nothing.
 *
 * Three limits are deliberate:
 * - **Typed tools only.** The pack's `run_document_python` runs code the model wrote. The worker is
 *   bounded but not yet a sandbox (the container profile is RASF-3111), so it is never attached here.
 * - **A lease with no inputs.** A task may create files in its role's formats and nothing else: there
 *   is no existing file it can open, because the host pins none.
 * - **No worker, no tools.** Without a provisioned interpreter the role loads as it is and the host
 *   says so; a tool that could only ever fail would be worse than no tool.
 */
import {
  type AgentChange,
  defineExtension,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import type { LoadedRole, OfficeDocumentFormat } from "@officehum/office";
import type { VersionedFileStore } from "@officehum/sdk";
import {
  DEFAULT_LIMITS,
  type DocumentLease,
  type DocumentService,
  localDocumentService,
  PAPER_INTERPRETER_VARIABLE,
  paperOfficeToolPack,
  resolvePaperInterpreter,
  runLedger,
  subprocessPaperWorker,
} from "@officehum/tools-paper-office";

/** How long a task's lease lasts from its first document call, in milliseconds. */
const LEASE_MS = 60 * 60 * 1000;

/** The prompt section key the document tools' guidance is shown under. */
export const DOCUMENTS_SECTION_KEY = "documents";

const NOUN: Readonly<Record<OfficeDocumentFormat, string>> = {
  docx: "Word documents",
  pptx: "PowerPoint presentations",
  xlsx: "Excel workbooks",
};

export interface DocumentDependencies {
  /** The environment the worker's interpreter is read from. Omitted: the process's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The document service; a test passes a fake. Omitted: the local one, over the real worker. */
  readonly service?: DocumentService;
  /** The clock a lease is dated from. Omitted: the system clock. */
  readonly now?: () => Date;
}

export interface DocumentToolsOptions {
  /** The office's file store: where a created file lands, and what `file` evidence reads. */
  readonly store: VersionedFileStore;
  /** Where the service keeps its record of each run, so a replayed call returns the same file. */
  readonly ledgerDir: string;
  readonly log: (line: string) => void;
  readonly dependencies?: DocumentDependencies;
}

/** What the role is told about the tools it was given: what they are for and what they are not. */
function guidance(formats: readonly OfficeDocumentFormat[]): string {
  const kinds = formats.map((format) => NOUN[format]).join(", ");
  return [
    `This office lets you make ${kinds} with the document tools.`,
    "- Make a file only when the work asks for one, such as a summary a person will open.",
    "- Every figure in a file comes from a tool result you have in front of you, copied exactly. Never type a figure from memory or work one out yourself; put a formula in the file when a total is needed.",
    "- A created file is a draft in the office's file store. Give its file id in your answer, and when you finish a ticket with agent_reply, attach it under the name the ticket asks for.",
    "- You cannot open, change or send any other file, and you cannot publish one: a person does that.",
  ].join("\n");
}

/** A conversation's extension selection with one more selected, in either form a role may state it. */
function selecting(
  selection: AgentChange["extensions"],
  extension: Extension,
): NonNullable<AgentChange["extensions"]> {
  if (selection === undefined || Array.isArray(selection)) return [...(selection ?? []), extension];
  const change = selection as { readonly add?: readonly Extension[] };
  return { ...change, add: [...(change.add ?? []), extension] };
}

/**
 * The role with the document tools its entry grants, or the role unchanged when it grants none or the
 * office has no worker to run them.
 */
export function withDocumentTools(
  role: LoadedRole,
  formats: readonly OfficeDocumentFormat[] | undefined,
  options: DocumentToolsOptions,
): LoadedRole {
  if (formats === undefined || formats.length === 0) return role;
  const dependencies = options.dependencies ?? {};
  const now = dependencies.now ?? (() => new Date());
  const agent = role.manifest.id;

  let service = dependencies.service;
  if (service === undefined) {
    const interpreter = resolvePaperInterpreter(dependencies.env ?? process.env);
    if (interpreter === undefined) {
      options.log(
        `Agent ${agent}: the office file grants it document tools, but ${PAPER_INTERPRETER_VARIABLE} is not set, so it runs without them. Provision the worker (packages/tools-paper-office/scripts/provision-worker.sh) and set the variable to its interpreter.`,
      );
      return role;
    }
    service = localDocumentService({
      store: options.store,
      worker: subprocessPaperWorker({ interpreter }),
      ledger: runLedger(options.ledgerDir),
      createdBy: `role:${agent}`,
      now,
    });
  }

  // One lease per task, granted on its first document call: the task's id, the role's formats, the
  // default budget and an hour. It names no input, so there is nothing for the task to read.
  const leases = new Map<string, DocumentLease>();
  const leaseFor = async ({ taskId }: { readonly taskId: string }): Promise<DocumentLease> => {
    const known = leases.get(taskId);
    if (known !== undefined) return known;
    const lease: DocumentLease = {
      leaseId: `lease:${agent}:${taskId}`,
      taskId,
      inputs: [],
      outputFormats: [...formats],
      limits: DEFAULT_LIMITS,
      expiresAt: new Date(now().getTime() + LEASE_MS).toISOString(),
    };
    leases.set(taskId, lease);
    return lease;
  };

  const pack = paperOfficeToolPack({
    service,
    leaseFor,
    includePythonWorkspace: false,
    includeWordTools: formats.includes("docx"),
    includePptxTools: formats.includes("pptx"),
    includeXlsxTools: formats.includes("xlsx"),
  });
  const extension = defineExtension({
    name: `${agent}.documents`,
    tools: [...pack.tools],
    sections: [section(DOCUMENTS_SECTION_KEY, () => guidance(formats))],
  });
  options.log(
    `Agent ${agent}: document tools for ${formats.join(", ")} (${pack.tools.length} tools).`,
  );
  return {
    ...role,
    bundle: {
      extensions: [...role.bundle.extensions, extension],
      agent: {
        ...role.bundle.agent,
        extensions: selecting(role.bundle.agent.extensions, extension),
      },
    },
  };
}
