/**
 * One relay process that kills itself at a chosen point, for `relay-kill.test.ts`.
 *
 * The relay's own tests (RASF-3067) simulate a crash by letting a throwing transport unwind
 * `pollOnce`. That proves the durable state is crash-consistent, which is the hard part, but the
 * process survives and closes its files. SIGKILL is a different event: no handler runs, so nothing is
 * flushed and nothing is checkpointed — Pi Durable's SQLite storage runs `wal_checkpoint(TRUNCATE)`
 * when it closes, and a killed process never gets there. What the parent then reads is what a dead
 * writer left mid-flight, which is the whole point.
 *
 * A fixture rather than a script string inside the test, so `biome` lints and formats it with the
 * rest of the package; `role-run-child.mjs` and `solo-owner-child.mjs` are the same shape. It loads
 * compiled modules by path because `createRelay`, `harnessTransport` and `openGuards` are internal to
 * `@officehum/office` — only `index.ts`, `board` and `board/testing` are exported — and this is a
 * plain `node` process, so nothing here is TypeScript.
 *
 *   OFFICEHUM_TEST_DIRECTORY  the office directory: `office.sqlite` (the board) and `harness.sqlite`
 *   OFFICEHUM_TEST_KILL       `created` | `admitted` | `completed`
 *
 * It leaves `relay-kill.json` behind, written synchronously on the way down: the evidence has to be
 * on disk before the signal lands, because a `process.send` may still be sitting in a stream buffer.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.OFFICEHUM_TEST_DIRECTORY;
const point = process.env.OFFICEHUM_TEST_KILL;
if (directory === undefined) throw new Error("OFFICEHUM_TEST_DIRECTORY is required");
if (point === undefined) throw new Error("OFFICEHUM_TEST_KILL is required");

/** `dist` sits beside `src`, and the package's internal modules are reachable only by path. */
const dist = new URL("../../dist/", import.meta.url);
const load = (relative) => import(new URL(relative, dist).href);
const { openOffice } = await load("adapter/index.js");
const { createWorkboard } = await load("board/testing.js");
const { openGuards } = await load("relay/guards.js");
const { createRelay } = await load("relay/relay.js");
const { harnessTransport } = await load("relay/transport.js");
const { scriptedProvider } = await load("testing/scripted-model.js");

const ANSWER = "Invoice 42 is paid.";
const ROLE = "bookkeeper";
const TYPE = "invoice.create";

let board;
let scripted;
let ticketId = null;

/** The board and the model, as this process sees them at the instant before it dies. */
const evidence = (phase) => ({
  pid: process.pid,
  point,
  phase,
  failed: null,
  ticketId,
  calls: scripted.calls,
  ticketStatus: ticketId === null ? null : (board.get(ticketId)?.status ?? null),
  rows:
    ticketId === null
      ? []
      : board.relay.deliveriesForTicket(ticketId).map((row) => ({
          kind: row.kind,
          state: row.state,
          submissionId: row.submissionId,
          targetKey: row.targetKey,
        })),
  cursor: board.relay.cursor(),
  events:
    ticketId === null
      ? []
      : board.events(ticketId).map((event) => ({ seq: event.seq, kind: event.kind })),
  waitTaskId: ticketId === null ? null : (board.relay.wait(ticketId)?.taskId ?? null),
});

/** Record what this process saw, then die by signal: no unwind, no close, no settling anything. */
const die = (phase) => {
  writeFileSync(join(directory, "relay-kill.json"), JSON.stringify(evidence(phase), null, 2));
  process.kill(process.pid, "SIGKILL");
};

/**
 * The delegate's one turn. On the `admitted` point it is also the kill point: the delivery row is
 * already `admitted` with its submission id, the answer has not been committed, and the process dies
 * inside the model call rather than after it.
 */
const script = () => {
  if (point === "admitted") die("delegate-model-turn");
  return { text: ANSWER };
};

scripted = scriptedProvider(script);
board = createWorkboard(join(directory, "office.sqlite"));
const office = await openOffice({
  storage: { sqlite: join(directory, "harness.sqlite") },
  models: scripted.models,
});

const inner = harnessTransport(office);
const transport = {
  kind: "harness",
  async deliver(target, message) {
    // The ledger row and the cursor are already committed; nothing has been submitted at all.
    if (point === "created") die("transport.deliver-before-submit");
    const handle = await inner.deliver(target, message);
    return {
      id: handle.id,
      async wait() {
        const outcome = await handle.wait();
        if (point === "completed") {
          // The delegate's own move: claim, then complete. The relay has not recorded the settlement
          // and the delegator's durable wait has not resumed.
          const current = board.get(ticketId);
          if (current !== undefined && current.status === "open") board.claim(ticketId, ROLE);
          board.complete(ticketId, ROLE);
          die("transport.wait-after-settlement");
        }
        return outcome;
      },
    };
  },
  reacquire: (target) => inner.reacquire(target),
};
const relay = createRelay({
  office,
  board,
  transport,
  routing: [{ roleKey: ROLE, agent: { model: scripted.model }, accepts: [TYPE] }],
  guards: openGuards(),
  now: () => Date.now(),
});

const ticket = await relay.dispatch(TYPE, {
  title: "Invoice 42",
  detail: "Please pay it.",
  createdBy: "front-desk",
  provenance: { origin: "internal", sourceChannel: "chat", sourceContact: "desk" },
});
ticketId = ticket.id;
if (point === "completed") {
  // The delegator asks before the delegate has done anything: the wait is a durable task, so it is
  // the same task in the process that recovers.
  const waiting = relay.wait(ticket.id, { timeoutMs: 10_000 });
  void waiting.catch(() => undefined);
}
await relay.pollOnce();

// Reaching here means the kill point never fired. Failing loudly beats a child that exits before its
// point and lets the parent assert on a fixture nothing happened to.
writeFileSync(
  join(directory, "relay-kill.json"),
  JSON.stringify({ ...evidence("none"), failed: "the kill point never fired" }, null, 2),
);
process.exit(1);
