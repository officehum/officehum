/**
 * The relay, killed by a real signal — the kill the simulated-crash tests cannot perform.
 *
 * `relay.test.ts` (RASF-3067) crashes the relay by letting an error out of its transport, and those
 * assertions are the ones worth keeping: the ledger row stays non-terminal, the cursor does not pass
 * an undelivered event, and a reopen settles each event once. But the process that crashed is still
 * alive to close both SQLite files, and the process that reopens them is the one that crashed. Two
 * things follow, and both hide the interesting half of the claim:
 *
 *  - Pi Durable's SQLite storage runs `wal_checkpoint(TRUNCATE)` when it closes, so the reopen reads
 *    a database that was already folded back into place. A killed writer leaves its WAL behind for
 *    another process to replay.
 *  - The reopened fixture reuses the crashed fixture's provider object, so its call count spans both
 *    runs. A kill that lands inside the delegate's model turn cannot finish that turn, and a fresh
 *    provider in the recovering process measures what actually happens to it.
 *
 * So each test here spawns a child that builds the same fixture `relay.test.ts` builds, walks to one
 * of the three points the issue names, and calls `process.kill(process.pid, "SIGKILL")` on itself.
 * Self-killing is what makes the point deterministic: there is no window in which a parent can signal
 * a child that has already begun an orderly close. Every wait is an event — the child's exit, the
 * durable wait task — with a bound, and the child's stderr rides along in the failure message so a
 * child that dies before its kill point reads as that, not as a pass.
 *
 * Offline and deterministic like the relay tests: scripted provider, no network, no credentials.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Office, openOffice } from "../adapter/index.js";
import type { Board } from "../board/index.js";
import { createWorkboard } from "../board/testing.js";
import { type ScriptedModel, scriptedProvider } from "../testing/scripted-model.js";
import { openGuards } from "./guards.js";
import { createRelay, type Relay, relayTicketKey } from "./relay.js";
import { harnessTransport } from "./transport.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DIRECTORY = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-relay-kill-"));
  temps.push(directory);
  return directory;
};

const ANSWER = "Invoice 42 is paid.";
const ROLE = "bookkeeper";
const TYPE = "invoice.create";

/** The child's report of its last durable view. One name, agreed with `relay-kill-child.mjs`. */
const REPORT = "relay-kill.json";

/** Where the process was standing when the signal landed, as the child names it itself. */
const PHASE = {
  created: "transport.deliver-before-submit",
  admitted: "delegate-model-turn",
  completed: "transport.wait-after-settlement",
} as const;

type KillPoint = keyof typeof PHASE;

type ChildReport = {
  readonly pid: number;
  readonly point: KillPoint;
  readonly phase: string;
  readonly failed: string | null;
  readonly ticketId: string;
  readonly calls: number;
  readonly ticketStatus: string | null;
  readonly rows: readonly {
    readonly kind: string;
    readonly state: string;
    readonly submissionId: number | null;
    readonly targetKey: string;
  }[];
  readonly cursor: number;
  readonly events: readonly { readonly seq: number; readonly kind: string }[];
  readonly waitTaskId: number | null;
};

/**
 * How long a child gets to reach its kill point. Under vitest's 30 s test timeout, so a hung child is
 * reported as a hung child rather than as a suite timeout, and killed so it cannot outlive the test.
 */
const CHILD_BOUND_MS = 20_000;

/** Wait for the child's exit event, bounded: a sleep here would be a guess, an event is a fact. */
function exit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the child did not exit within ${CHILD_BOUND_MS} ms; it was killed`));
    }, CHILD_BOUND_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Spawn one child over a fresh directory, wait for it to die, and hand back the report it left.
 *
 * The death is asserted here, before anything is read: a child that exits with a code threw or
 * returned instead of dying, and its stderr says why. Nothing below is meaningful without the signal.
 */
async function killAt(point: KillPoint): Promise<{ directory: string; report: ChildReport }> {
  const directory = DIRECTORY();
  const child = spawn(
    process.execPath,
    ["--no-warnings", fileURLToPath(new URL("../fixtures/relay-kill-child.mjs", import.meta.url))],
    {
      cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
      env: { ...process.env, OFFICEHUM_TEST_DIRECTORY: directory, OFFICEHUM_TEST_KILL: point },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });

  const { code, signal } = await exit(child);
  expect(
    { code, signal, stderr: stderr.trim() },
    `the ${point} child must die by the signal, with no exit code and nothing on stderr`,
  ).toEqual({ code: null, signal: "SIGKILL", stderr: "" });
  // The parent's own record of the same fact, which is the field a reader reaches for first.
  expect(child.signalCode).toBe("SIGKILL");

  // Checked before this process opens either file: a writer that closed cleanly checkpoints and
  // removes its WAL, and this one never got the chance. The recovering process replays it.
  expect(existsSync(join(directory, "harness.sqlite-wal"))).toBe(true);
  expect(existsSync(join(directory, "office.sqlite-wal"))).toBe(true);

  const report = JSON.parse(readFileSync(join(directory, REPORT), "utf8")) as ChildReport;
  expect(report.failed, `the ${point} child never reached its kill point`).toBeNull();
  expect(report.point).toBe(point);
  expect(report.phase).toBe(PHASE[point]);
  // The process that died is not this one. Recovery below happens in a pid the crash never touched.
  expect(report.pid).not.toBe(process.pid);
  return { directory, report };
}

/**
 * Pi Durable's own submission rows, read from the file rather than through the adapter.
 *
 * The claim is about what outlived a dead process, and the adapter's view begins when *this* process
 * opens the office. Reading the file also forces the WAL to be replayed — which is the recovery a
 * restart performs and the simulated-crash tests skip. The table is the storage's (`submissions`, no
 * prefix by default); a rename there fails this test loudly, which is the right way for it to break.
 */
function submissions(file: string): readonly { readonly id: number; readonly status: string }[] {
  const database = new DatabaseSync(file);
  try {
    return database.prepare("SELECT id, status FROM submissions ORDER BY id").all() as unknown as {
      readonly id: number;
      readonly status: string;
    }[];
  } finally {
    database.close();
  }
}

interface Recovered {
  readonly board: Board;
  readonly office: Office;
  readonly relay: Relay;
  readonly scripted: ScriptedModel;
  close(): Promise<void>;
}

/**
 * The same two files, opened by this process, with a fresh scripted provider.
 *
 * `openOffice` resumes by default, so an unsettled submission is rescheduled here — the recovery a
 * restart performs. The provider is new on purpose: it counts only what this process was asked to
 * run, so a delivery that resumes from durable state shows up as no call at all.
 */
async function recoverIn(directory: string): Promise<Recovered> {
  const scripted = scriptedProvider([{ text: ANSWER }]);
  const board = createWorkboard(join(directory, "office.sqlite"));
  const office = await openOffice({
    storage: { sqlite: join(directory, "harness.sqlite") },
    models: scripted.models,
  });
  const relay = createRelay({
    office,
    board,
    transport: harnessTransport(office),
    routing: [{ roleKey: ROLE, agent: { model: scripted.model }, accepts: [TYPE] }],
    guards: openGuards(),
    now: () => Date.now(),
  });
  return {
    board,
    office,
    relay,
    scripted,
    async close() {
      await office.close();
      board.close();
    },
  };
}

/**
 * The delegator's side of the crash: finish the ticket if the dead process did not, let the relay
 * account for the completion, and resolve the wait. `claim`/`complete` are the board's own moves
 * standing in for the delegate's tools (RASF-3109), exactly as `relay.test.ts` uses them.
 */
async function settleAndWait(fixture: Recovered, ticketId: string) {
  const before = fixture.board.get(ticketId);
  if (before !== undefined && before.status === "open") fixture.board.claim(ticketId, ROLE);
  const current = fixture.board.get(ticketId);
  if (current !== undefined && current.status !== "done" && current.status !== "cancelled") {
    fixture.board.complete(ticketId, ROLE);
  }
  await fixture.relay.pollOnce();
  return await fixture.relay.wait(ticketId, { timeoutMs: 10_000 });
}

/**
 * What must hold however the process died, read from the files this process opened.
 *
 * One ledger row per board event and no more: the cursor and the row move in one transaction, which
 * is what makes "the cursor is never past an undelivered event" a property of the file, so a
 * redelivery after a real kill must not add a second row. The `created` delivery settled with the
 * delegate's answer, so the delegate's work exists exactly once. The ticket completed once, and its
 * `completed` event was consumed by the ledger rather than submitted as input.
 */
function expectSettledOnce(fixture: Recovered, ticketId: string, answer: string): void {
  const events = fixture.board.events(ticketId);
  const rows = fixture.board.relay.deliveriesForTicket(ticketId);
  expect(rows.map((row) => [row.seq, row.kind])).toEqual(
    events.map((event) => [event.seq, event.kind]),
  );

  const created = rows.filter((row) => row.kind === "created");
  expect(created).toHaveLength(1);
  expect(created[0]?.state).toBe("settled");
  expect(created[0]?.outcome).toBe(answer);

  const completed = rows.filter((row) => row.kind === "completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]?.state).toBe("settled");
  expect(completed[0]?.targetKey).toBe("");
  expect(events.filter((event) => event.kind === "completed")).toHaveLength(1);
  expect(fixture.board.get(ticketId)?.status).toBe("done");

  // Nothing is behind the cursor without a row, and nothing is above it.
  expect(fixture.board.relay.cursor()).toBe(events.at(-1)?.seq ?? -1);
  expect(fixture.board.relay.openDeliveries()).toEqual([]);
}

/** A second recovery pass over settled state must change nothing, or the file is not idempotent. */
async function expectIdempotent(fixture: Recovered, ticketId: string): Promise<void> {
  await fixture.relay.recover();
  await fixture.relay.pollOnce();
  expectSettledOnce(fixture, ticketId, ANSWER);
}

describe("relay killed by signal", () => {
  it("kills the process after the ticket is created, before any delivery is attempted", async () => {
    const { directory, report } = await killAt("created");

    // The dead process's own view: the row and the cursor are committed together, nothing was
    // submitted, and the model was never asked to run.
    expect(report.calls).toBe(0);
    expect(report.rows).toEqual([
      {
        kind: "created",
        state: "pending",
        submissionId: null,
        targetKey: relayTicketKey(ROLE, report.ticketId),
      },
    ]);
    expect(report.cursor).toBe(report.events[0]?.seq ?? -1);
    expect(report.ticketStatus).toBe("open");
    expect(report.waitTaskId).toBeNull();
    // No process ever admitted a submission, so the harness file holds none.
    expect(submissions(join(directory, "harness.sqlite"))).toEqual([]);

    const recovered = await recoverIn(directory);
    try {
      await recovered.relay.recover();
      const rows = recovered.board.relay.deliveriesForTicket(report.ticketId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.outcome).toBe(ANSWER);
      expect(rows[0]?.submissionId).not.toBeNull();
      // A `pending` row carries no submission id, so recovery re-submits the same event id and
      // Pi Durable admits it — once, in a process that never saw the ticket before.
      expect(recovered.scripted.calls).toBe(1);

      const result = await settleAndWait(recovered, report.ticketId);
      expect(result).toEqual({
        ok: true,
        ticketId: report.ticketId,
        status: "completed",
        answer: ANSWER,
      });
      expectSettledOnce(recovered, report.ticketId, ANSWER);
      await expectIdempotent(recovered, report.ticketId);

      // One submission, admitted by the recovering process, and nothing left unsettled.
      expect(submissions(join(directory, "harness.sqlite"))).toHaveLength(1);
      expect(await recovered.office.openSubmissions()).toEqual([]);
      // One model call between the two processes: nobody ran the delegate before it was killed.
      expect(report.calls + recovered.scripted.calls).toBe(1);
    } finally {
      await recovered.close();
    }
  });

  it("kills the process inside the delegate's run, after the delivery was admitted", async () => {
    const { directory, report } = await killAt("admitted");

    // The dead process's own view: the row is `admitted` with Pi Durable's submission id, the
    // delegate's turn had begun, and the answer was never committed.
    expect(report.calls).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.state).toBe("admitted");
    expect(report.rows[0]?.submissionId).not.toBeNull();
    expect(report.cursor).toBe(report.events[0]?.seq ?? -1);
    expect(report.ticketStatus).toBe("open");

    // The admission is durable in the file the dead process left, before this process opens anything.
    const admitted = report.rows[0]?.submissionId ?? -1;
    expect(submissions(join(directory, "harness.sqlite")).map((row) => row.id)).toEqual([admitted]);

    const recovered = await recoverIn(directory);
    try {
      await recovered.relay.recover();
      const rows = recovered.board.relay.deliveriesForTicket(report.ticketId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.outcome).toBe(ANSWER);
      // The same submission, reacquired by id rather than submitted a second time.
      expect(rows[0]?.submissionId).toBe(admitted);

      // The kill landed inside the model turn, so that turn never returned and could not have
      // committed an answer: the recovering process runs it again. This is the difference the
      // simulated tests cannot show — their crash leaves a live process, the run it had started
      // finishes, and the reopened fixture reuses the crashed provider's count, so one call covers
      // both runs. Here the model call is at-least-once while the submission and the ledger row stay
      // exactly-once, which is what the relay's dedupe key actually promises.
      expect(recovered.scripted.calls).toBe(1);
      expect(report.calls + recovered.scripted.calls).toBe(2);

      const result = await settleAndWait(recovered, report.ticketId);
      expect(result).toEqual({
        ok: true,
        ticketId: report.ticketId,
        status: "completed",
        answer: ANSWER,
      });
      expectSettledOnce(recovered, report.ticketId, ANSWER);
      await expectIdempotent(recovered, report.ticketId);

      // Still one submission: the resumed one. No second admission, and nothing left unsettled.
      expect(submissions(join(directory, "harness.sqlite")).map((row) => row.id)).toEqual([
        admitted,
      ]);
      expect(await recovered.office.openSubmissions()).toEqual([]);
    } finally {
      await recovered.close();
    }
  });

  it("kills the process after the ticket completed, before the delegator resumes", async () => {
    const { directory, report } = await killAt("completed");

    // The dead process's own view: the delegate settled and completed the ticket, the delegator was
    // parked on its durable wait, and the relay had not yet recorded the settlement.
    expect(report.calls).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.state).toBe("admitted");
    expect(report.rows[0]?.submissionId).not.toBeNull();
    expect(report.ticketStatus).toBe("done");
    expect(report.events.map((event) => event.kind)).toEqual(["created", "claimed", "completed"]);
    // The cursor stops at the event the relay had accounted for: the completion is durable on the
    // board and undelivered to the ledger, which is exactly the state recovery has to resolve.
    expect(report.cursor).toBe(report.events[0]?.seq ?? -1);
    expect(report.waitTaskId).not.toBeNull();

    const admitted = report.rows[0]?.submissionId ?? -1;
    expect(submissions(join(directory, "harness.sqlite")).map((row) => row.id)).toEqual([admitted]);

    const recovered = await recoverIn(directory);
    try {
      // The delegator's wait is the same durable task, in a process that never ran it: the wait's
      // identity comes from the board's own row, not from the dead process's memory.
      expect(recovered.board.relay.wait(report.ticketId)?.taskId).toBe(report.waitTaskId);

      await recovered.relay.recover();
      const rows = recovered.board.relay.deliveriesForTicket(report.ticketId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.outcome).toBe(ANSWER);
      expect(rows[0]?.submissionId).toBe(admitted);
      // The answer was already committed when the process died, so recovery reads it: the delegate
      // did not run again here, which is the claim the simulated test makes with a shared counter.
      expect(recovered.scripted.calls).toBe(0);

      const result = await settleAndWait(recovered, report.ticketId);
      expect(result).toEqual({
        ok: true,
        ticketId: report.ticketId,
        status: "completed",
        answer: ANSWER,
      });
      // The completion was already on the board before the kill, so this process delivers the
      // `claimed` and `completed` events it left unaccounted, settling each once.
      expectSettledOnce(recovered, report.ticketId, ANSWER);
      await expectIdempotent(recovered, report.ticketId);

      expect(submissions(join(directory, "harness.sqlite")).map((row) => row.id)).toEqual([
        admitted,
      ]);
      expect(await recovered.office.openSubmissions()).toEqual([]);
      // One model call between the two processes, both of them in the dead one.
      expect(report.calls + recovered.scripted.calls).toBe(1);
    } finally {
      await recovered.close();
    }
  });
});
