/**
 * Completion evidence: a ticket is done only when what its type declares checks out (RASF-3230).
 *
 * A role's `officehum.json` says, per ticket type it accepts, what must be true before a ticket of
 * that type is done (`accepts[].done`): an engine check, a record a safe tool can find, a file, a
 * person's confirmation. Nobody talks a status into existence, so the host runs those checks when an
 * agent replies, and the reply only completes the ticket when every one passes. The model neither
 * runs the checks nor sees a way round them: `agent_reply` is the only tool that finishes a ticket,
 * and it ends here.
 *
 * `completeWithEvidence` makes exactly one move on the board:
 *
 * - every check passed and no person is asked → `done`, with the evidence on the `completed` event;
 * - every check passed and the type asks for a person → `awaiting_confirmation`, with a request in
 *   the Inbox; the person's yes completes the ticket and their no returns it (the board does both);
 * - any check failed → one `evidence_failed` event naming each failure, the ticket still with the
 *   agent; the third failure blocks the ticket and hands it to a person;
 * - the type declares no evidence → `done` as before, with a warning on the event, so a role written
 *   before evidence existed keeps working.
 *
 * A check this office has no means to run fails; it is never skipped. That is the same rule as a
 * gated action with no approver.
 */
import {
  type AgentManifest,
  type DoneEvidence,
  type Engine,
  type EvidenceTicket,
  type EvidenceValue,
  evidenceEngineArgs,
  type FileStore,
  resolveEvidenceArgs,
} from "@officehum/sdk";
import {
  type Board,
  type EvidenceResult,
  evidenceLine,
  MAX_EVIDENCE_ATTEMPTS,
  type Person,
  type Ticket,
} from "./index.js";

/** What running a role's evidence tool gave back: its `details`, or why it could not be run. */
export interface ToolEvidence {
  readonly details: unknown;
  readonly error?: string;
}

/** The means a host has of running each kind of check. A kind with no means fails its checks. */
export interface EvidenceRunners {
  /** The engine of the role that holds the ticket. */
  readonly engine?: Engine;
  /** Runs one of that role's declared safe tools, through the role's extension and never the model. */
  readonly runTool?: (
    name: string,
    args: Readonly<Record<string, EvidenceValue>>,
  ) => Promise<ToolEvidence>;
  /** The office's file store, where a reply's attached files are looked up. */
  readonly files?: FileStore;
}

export interface CompletionRequest {
  readonly board: Board;
  readonly ticketId: string;
  /** Who says the ticket is done: the agent that holds it, or a person marking it done for one. */
  readonly actor: string;
  readonly result: string;
  /** The files the reply attaches, as declared name → file id. */
  readonly files?: Readonly<Record<string, string>>;
  /** The manifest of the role that holds the ticket; its `accepts` entry for the type is the evidence. */
  readonly manifest: AgentManifest | undefined;
  readonly runners: EvidenceRunners;
}

export type CompletionOutcome =
  | {
      readonly status: "done";
      readonly ticket: Ticket;
      readonly evidence: readonly EvidenceResult[];
      /** Set when the ticket's type declared nothing to check. */
      readonly warning?: string;
    }
  | {
      readonly status: "awaiting_confirmation";
      readonly ticket: Ticket;
      readonly evidence: readonly EvidenceResult[];
      readonly person: Person;
    }
  | {
      readonly status: "failed";
      readonly ticket: Ticket;
      readonly failures: readonly EvidenceResult[];
      readonly attempt: number;
    }
  | {
      readonly status: "blocked";
      readonly ticket: Ticket;
      readonly failures: readonly EvidenceResult[];
      /** The person the ticket was handed to, when the office knows one. */
      readonly person?: Person;
    };

type CheckedEvidence = Exclude<DoneEvidence, { person: true }>;

/** Engine data and tool details are recorded with the result, up to this size; past it, only the fact. */
const FOUND_BYTES = 4000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `value` when it is JSON small enough to keep on an event, else a note that it was left out. */
function kept(value: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) return undefined;
  return json.length <= FOUND_BYTES ? value : { omitted: `${json.length} characters of output` };
}

function failed(
  kind: EvidenceResult["kind"],
  check: string,
  reason: string,
  found?: unknown,
): EvidenceResult {
  const record = kept(found);
  return { kind, check, passed: false, reason, ...(record === undefined ? {} : { found: record }) };
}

async function checkEngine(
  entry: Extract<CheckedEvidence, { engine: readonly string[] }>,
  ticket: EvidenceTicket,
  runners: EvidenceRunners,
): Promise<EvidenceResult> {
  const check = entry.engine.join(" ");
  const resolved = resolveEvidenceArgs(entry.args, ticket);
  if (!resolved.ok) return failed("engine", check, missingText(resolved.missing));
  if (runners.engine === undefined) {
    return failed("engine", check, "this office has no engine for the role to run the check with");
  }
  let result: Awaited<ReturnType<Engine["run"]>>;
  try {
    result = await runners.engine.run(evidenceEngineArgs(entry.engine, resolved.args));
  } catch (error) {
    return failed("engine", check, `the engine could not be run: ${messageOf(error)}`);
  }
  const findings = result.findings.map((finding) => finding.id);
  if (!result.ok) {
    return failed("engine", check, result.error ?? "the engine reported a failure", {
      findings,
      data: result.data ?? null,
      caveats: result.caveats,
    });
  }
  if (findings.length === 0) {
    return failed("engine", check, "the engine found nothing that shows the work was done", {
      findings,
      data: result.data ?? null,
    });
  }
  return { kind: "engine", check, passed: true, found: { findings } };
}

async function checkTool(
  entry: Extract<CheckedEvidence, { tool: string }>,
  ticket: EvidenceTicket,
  runners: EvidenceRunners,
): Promise<EvidenceResult> {
  const resolved = resolveEvidenceArgs(entry.args, ticket);
  if (!resolved.ok) return failed("tool", entry.tool, missingText(resolved.missing));
  if (runners.runTool === undefined) {
    return failed(
      "tool",
      entry.tool,
      "this office has no way to run the role's tool for the check",
    );
  }
  let evidence: ToolEvidence;
  try {
    evidence = await runners.runTool(entry.tool, resolved.args);
  } catch (error) {
    return failed("tool", entry.tool, `the tool could not be run: ${messageOf(error)}`);
  }
  if (evidence.error !== undefined) {
    return failed("tool", entry.tool, `the tool failed: ${evidence.error}`, evidence.details);
  }
  if (recordOf(evidence.details)?.found !== true) {
    return failed(
      "tool",
      entry.tool,
      `found no record for ${JSON.stringify(resolved.args)}`,
      evidence.details,
    );
  }
  const found = kept(evidence.details);
  return {
    kind: "tool",
    check: entry.tool,
    passed: true,
    ...(found === undefined ? {} : { found }),
  };
}

async function checkFile(
  entry: Extract<CheckedEvidence, { file: string }>,
  request: CompletionRequest,
): Promise<EvidenceResult> {
  const fileId = request.files?.[entry.file];
  if (fileId === undefined) {
    return failed(
      "file",
      entry.file,
      `the reply attached no file under "${entry.file}"; pass it as files: { "${entry.file}": "<file id>" }`,
    );
  }
  if (request.runners.files === undefined) {
    return failed("file", entry.file, "this office has no file store to look the file up in");
  }
  let ref: Awaited<ReturnType<FileStore["info"]>>;
  try {
    ref = await request.runners.files.info(fileId);
  } catch (error) {
    return failed("file", entry.file, `the file store could not be read: ${messageOf(error)}`);
  }
  if (ref === undefined) {
    return failed("file", entry.file, `no file ${fileId} is in the office's file store`);
  }
  return {
    kind: "file",
    check: entry.file,
    passed: true,
    found: { fileId: ref.id, name: ref.name, sha256: ref.sha256 },
  };
}

function missingText(missing: readonly string[]): string {
  return `the ticket's data has no value for ${missing.join(", ")}, so the check cannot be addressed`;
}

/**
 * Runs the ticket type's declared checks and makes the one board move they call for. Refusals the
 * board would give `complete` (not the assignee, already closed, awaiting a person) are thrown as its
 * `BoardError` before any check runs.
 */
export async function completeWithEvidence(request: CompletionRequest): Promise<CompletionOutcome> {
  const { board, actor, result } = request;
  const ticket = board.completable(request.ticketId, actor);
  const declared = request.manifest?.accepts.find((accept) => accept.type === ticket.type)?.done;
  if (declared === undefined || declared.length === 0) {
    const warning = `${request.manifest?.id ?? actor} declares no completion evidence for ${ticket.type}, so nothing was checked.`;
    return {
      status: "done",
      ticket: board.complete(ticket.id, actor, { result, warning }),
      evidence: [],
      warning,
    };
  }

  const subject: EvidenceTicket = { id: ticket.id, data: ticket.payload };
  const results: EvidenceResult[] = [];
  let asksPerson = false;
  // Every check runs, so one reply tells the agent everything that is missing, not the first thing.
  for (const entry of declared) {
    if ("person" in entry) asksPerson = true;
    else if ("engine" in entry) results.push(await checkEngine(entry, subject, request.runners));
    else if ("tool" in entry) results.push(await checkTool(entry, subject, request.runners));
    else results.push(await checkFile(entry, request));
  }

  const people = board.people();
  // The same person the relay falls back to: the office's first.
  const person = people[0];
  // A person marking the ticket done is the confirmation; an agent's reply has to ask for one.
  const confirmedByActor = people.some((candidate) => candidate.id === actor);
  if (asksPerson && !confirmedByActor && person === undefined) {
    results.push(
      failed(
        "person",
        "person",
        "a person must confirm this and the office's board knows no people; add them to the company record",
      ),
    );
  }

  const failures = results.filter((entry) => !entry.passed);
  if (failures.length > 0) {
    const outcome = board.evidenceFailed(ticket.id, actor, {
      failures,
      ...(person === undefined ? {} : { blockTo: { kind: "person" as const, id: person.id } }),
    });
    return outcome.blocked
      ? {
          status: "blocked",
          ticket: outcome.ticket,
          failures,
          ...(person === undefined ? {} : { person }),
        }
      : { status: "failed", ticket: outcome.ticket, failures, attempt: outcome.attempt };
  }

  if (asksPerson && !confirmedByActor && person !== undefined) {
    return {
      status: "awaiting_confirmation",
      ticket: board.awaitConfirmation(ticket.id, actor, {
        result,
        evidence: results,
        person: person.id,
      }),
      evidence: results,
      person,
    };
  }

  const evidence: EvidenceResult[] = asksPerson
    ? [...results, { kind: "person", check: "person", passed: true, found: { confirmedBy: actor } }]
    : results;
  return {
    status: "done",
    ticket: board.complete(ticket.id, actor, { result, evidence }),
    evidence,
  };
}

/** What a reply that did not complete its ticket tells the agent: each failed check and what to do. */
export function failedCompletionText(
  outcome: Extract<CompletionOutcome, { status: "failed" | "blocked" }>,
): string {
  const checks = outcome.failures.map(evidenceLine);
  if (outcome.status === "blocked") {
    return [
      `Ticket ${outcome.ticket.id} is not done, and is now blocked: its completion checks failed ${MAX_EVIDENCE_ATTEMPTS} times.`,
      ...checks,
      `It is with ${outcome.person?.name ?? "a person"} now. Stop working on it and say so in your answer.`,
    ].join("\n");
  }
  return [
    `Ticket ${outcome.ticket.id} is not done: these completion checks failed (attempt ${outcome.attempt} of ${MAX_EVIDENCE_ATTEMPTS}).`,
    ...checks,
    "Do what is missing, then reply again. Saying it is done does not make it so.",
  ].join("\n");
}

/** What a reply whose checks passed, and now waits on a person, tells the agent. */
export function awaitingConfirmationText(ticketId: string, person: Person): string {
  return `Ticket ${ticketId} passed its checks and is waiting for ${person.name} to confirm it is done. You are finished with it unless it comes back to you; do not reply to it again.`;
}
