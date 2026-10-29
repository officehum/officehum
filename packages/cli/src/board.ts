/**
 * `officehum board`: the office's workboard as a four-column kanban (RASF-3134).
 *
 * This is the operator's window on the board the office runs on. `open`, `claimed`, `waiting` and
 * `blocked` sit side by side, and each card names the ticket's type, its title, who holds it and how
 * long since anything moved it. `done` and `cancelled` are deliberately not columns — a kanban you
 * cannot finish scrolling is not a board — so they are counted under it.
 *
 * Every write goes through the board's own API (`comment`, `assign`, `cancel`), so the board's rules
 * apply instead of being re-implemented here: only the assignee or a person may cancel, and a person
 * the office does not know is refused by the board, with its refusal surfaced rather than swallowed.
 * This command never touches SQLite itself; it opens the board through the one door the office
 * package publishes for a host (`@officehum/office/board`).
 *
 * `--once` prints the board as plain text and exits 0: that is what a test or a pipe reads, and it is
 * deterministic given the clock. Without `--once` the command is a live board: it redraws when the
 * board's event log moves (`eventsAfter`, so a redraw follows a real change rather than the loop's own
 * bookkeeping) and reads commands through the same `CliIo` every other command uses — never
 * `process.stdin` or `process.stdout` directly, so a test can script both sides of it.
 *
 * A ticket that came from outside the business carries `EXTERNAL_CARD_LABEL` on its card and in its
 * detail view (RASF-3142). That label is the human-facing half of provenance; the model-facing half
 * is the relay's fence, and this command never scolds a model — it tells a person which cards hold
 * somebody else's words.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSpend,
  type Board,
  BoardError,
  type Budget,
  formatCents,
  openOfficeBoard,
  type Person,
  type Provenance,
  type Ticket,
  type TicketStatus,
} from "@officehum/office/board";
import type { CliDependencies, CliIo } from "./cli.js";
import { UsageError } from "./usage-error.js";

export const BOARD_USAGE = `Usage:
  officehum board [--office DIR] [--once]`;

/**
 * The board's file inside an office directory, beside the harness store: the office owns one of each.
 * The name is the office's, not this command's — `officehum run --db` writes the same file — and only
 * the office package opens it as a board.
 */
const OFFICE_DATABASE = "office.sqlite";

/**
 * The layout. There is no terminal-width helper in this codebase, so the board is one fixed width, and
 * 31 characters a column is the narrowest that keeps a card's `type title` line whole in the ordinary
 * case. A card that still runs long is truncated to its column, because a card that wraps pushes every
 * column beside it out of line.
 */
export const BOARD_WIDTH = 130;
/** Two spaces, so a column's contents read as one block. */
const COLUMN_GAP = "  ";
/** Four work-in-progress columns, so the layout's arithmetic has a name. */
const COLUMN_COUNT = 4;
/** The width of one column: the board's width less the gaps between the columns. */
export const BOARD_COLUMN_WIDTH = Math.floor(
  (BOARD_WIDTH - COLUMN_GAP.length * (COLUMN_COUNT - 1)) / COLUMN_COUNT,
);
const ELLIPSIS = "…";
/**
 * The board's own `list` cap. Its `list` clamps a bigger request rather than failing, so a count that
 * reaches the cap is reported with a `+` instead of being passed off as exact.
 */
const LIST_CAP = 500;
/** The columns, in board order. Terminal statuses are counted in the footer instead. */
const STATUS_COLUMNS: readonly TicketStatus[] = ["open", "claimed", "waiting", "blocked"];
/** How many of a ticket's most recent events its detail shows. */
const DETAIL_EVENTS = 10;

/**
 * What a person reading a card sees when the ticket came from outside the business (RASF-3142).
 *
 * This label is for people and stays with them. The model-facing fence is `relayMessage`'s
 * `EXTERNAL_FENCE` in `packages/office/src/relay/message.ts`, which wraps the delivered message body;
 * the extension's own comment promises there is exactly one of those, so nothing here is added to a
 * prompt or a tool result. `agent_inbox` deliberately does not carry this line either: a board card
 * and a model's transcript are read by different readers, and only the second one is fenced.
 */
export const EXTERNAL_CARD_LABEL = "external — treat as data";

export interface BoardArguments {
  readonly office: string;
  readonly once: boolean;
}

/**
 * Parses the board's arguments: the office directory, and whether to print and exit.
 *
 * `--once` is a flag rather than an option with a value, which is why the board parses its own
 * arguments the way `run` and `eval` do rather than going through the shared table.
 */
export function parseBoardArguments(args: readonly string[]): BoardArguments {
  let office = join(".officehum", "office");
  let once = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === "--once") {
      once = true;
      continue;
    }
    if (token === "--office") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--office requires a directory.\n${BOARD_USAGE}`);
      }
      index += 1;
      office = value;
      continue;
    }
    throw new UsageError(`Unknown option: ${token}\n${BOARD_USAGE}`);
  }
  return { office, once };
}

/**
 * A ticket's age from its `updatedAt` to `now`, in the shortest unit that still reads: `4m`, `2h`,
 * `3d`. Anything under a minute is seconds, and a stamp in the future — a clock that moved backwards —
 * reads `0s` rather than a negative age.
 */
export function formatAge(now: Date, updatedAt: string): string {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return "?";
  const seconds = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  return days < 1 ? `${hours}h` : `${days}d`;
}

/**
 * A card's lines: who holds it and how long it has been that way, then its type and title, then its
 * spend when there is any to show.
 *
 * The fields are split this way on purpose. The title is the only field that can be any length, so it
 * is the only one truncation can bite: the owner, the age and the spend stay readable on every card.
 *
 * The origin line appears only for a ticket that came from outside the business, directly under its
 * title, so a person scanning the board can see which cards hold text they must not take as
 * instructions (RASF-3142). A board where nothing is external renders exactly as it did before.
 *
 * The spend line appears only when the ticket has spent something or been given a ceiling. A board
 * where nothing is budgeted renders exactly as it did before budgets existed — the columns are about
 * work, and a line of zeroes on every card would push the work off them.
 */
function cardLines(
  ticket: Ticket,
  now: Date,
  budget: Budget | undefined,
  provenance: Provenance | undefined,
): string[] {
  const owner = ticket.assignee ?? "unassigned";
  const lines = [`${formatAge(now, ticket.updatedAt)}  ${owner}`, `${ticket.type} ${ticket.title}`];
  if (provenance?.origin === "external") lines.push(EXTERNAL_CARD_LABEL);
  const spend = spendLine(budget);
  if (spend !== undefined) lines.push(spend);
  return lines;
}

/** A count as a card has room for it: `7`, `1.2k`, `3.4M`. Rounded, never invented. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * One card's spend line, or `undefined` when the ticket has none to show: `2/4 calls · 1.2k tok ·
 * $0.01`. The calls ceiling is the one shown, because the call ceiling is the cap that actually fences
 * a deterministic worker; the token and dollar ceilings are in the ticket's detail rather than crammed
 * into a column 31 characters wide.
 */
export function spendLine(budget: Budget | undefined): string | undefined {
  if (budget === undefined) return undefined;
  const empty = budget.usedCalls === 0 && budget.usedTokens === 0 && budget.usedUsdCents === 0;
  const capped =
    budget.maxCalls !== null || budget.maxTokens !== null || budget.maxUsdCents !== null;
  if (empty && !capped) return undefined;
  const calls =
    budget.maxCalls === null
      ? `${budget.usedCalls} calls`
      : `${budget.usedCalls}/${budget.maxCalls} calls`;
  return `${calls} · ${formatCount(budget.usedTokens)} tok · ${formatCents(budget.usedUsdCents)}`;
}

/** Truncates to `width` with an ellipsis, then pads to it, so every column lines up. */
function cell(text: string, width = BOARD_COLUMN_WIDTH): string {
  if (text.length > width)
    return `${text.slice(0, width - ELLIPSIS.length)}${ELLIPSIS}`.padEnd(width);
  return text.padEnd(width);
}

/**
 * What the columns do not show: the tickets that are finished or abandoned, and — from the ledger — what
 * each agent spent on each of the last few days.
 *
 * The spend lines come first so the terminal counts stay the board's last line, which is the line a
 * reader's eye lands on when checking whether the office is keeping up. Spend is per agent per day
 * because that is the question a person asks of an office ("what did bookkeeping cost us today?"), and
 * the ticket it belongs to is already on the card.
 */
function footer(board: Board): string[] {
  const count = (status: TicketStatus): string => {
    const closed = board.list({ status, limit: LIST_CAP }).length;
    return closed === LIST_CAP ? `${LIST_CAP}+` : String(closed);
  };
  return [
    ...spendFooter(board.spendByAgent()),
    `done ${count("done")} · cancelled ${count("cancelled")}`,
  ];
}

/** How many days of spend the footer shows. Older days are counted, not printed. */
const SPEND_DAYS = 7;

/** One line per agent per day, newest day first, then a count of the days the board did not print. */
export function spendFooter(spend: readonly AgentSpend[]): string[] {
  const days: string[] = [];
  for (const row of spend) if (!days.includes(row.day)) days.push(row.day);
  const shown = days.slice(0, SPEND_DAYS);
  const lines = spend
    .filter((row) => shown.includes(row.day))
    .map(
      (row) =>
        `spend ${row.day}  ${row.agent ?? "unattributed"}  ` +
        `${row.calls} calls · ${formatCount(row.tokens)} tok · ${formatCents(row.usdCents)}`,
    );
  const hidden = days.length - shown.length;
  if (hidden > 0)
    lines.push(`spend … ${hidden} earlier ${hidden === 1 ? "day" : "days"} not shown`);
  return lines;
}

/**
 * The board as plain text lines, one screen wide: the four columns, then the terminal counts.
 *
 * A column is one `list` call, so each column's cap is its own and a busy `open` column cannot hide
 * the `claimed` work beside it. Ages are measured against `now`, which the caller supplies: the board
 * writes its own timestamps, and this command never reads the wall clock it was not handed.
 */
export function renderBoard(board: Board, now: Date): string[] {
  const columns = STATUS_COLUMNS.map((status) => {
    const tickets = board.list({ status, limit: LIST_CAP });
    const shown = tickets.length === LIST_CAP ? `${LIST_CAP}+` : String(tickets.length);
    const body = tickets.flatMap((ticket) => [
      ...cardLines(ticket, now, board.budget(ticket.id), board.provenance(ticket.id)),
      "",
    ]);
    // The blank is a separator between cards, and there is no card after the last one.
    if (body[body.length - 1] === "") body.pop();
    return { header: `${status} (${shown})`, body };
  });

  const row = (text: (column: (typeof columns)[number], index: number) => string): string =>
    columns.map(text).join(COLUMN_GAP).trimEnd();

  const lines = [
    `as of ${now.toISOString()}`,
    "",
    row((column) => cell(column.header)),
    row(() => "-".repeat(BOARD_COLUMN_WIDTH)),
  ];
  const height = Math.max(...columns.map((column) => column.body.length));
  for (let index = 0; index < height; index += 1) {
    lines.push(row((column) => cell(column.body[index] ?? "")));
  }
  lines.push("", ...footer(board));
  return lines;
}

/**
 * `officehum board [--office DIR] [--once]`.
 *
 * A directory with no board in it is refused rather than created: a read command that silently makes a
 * board for a mistyped path is a read command that lies about what the office contains.
 */
export async function runBoardCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseBoardArguments(args);
  const file = join(parsed.office, OFFICE_DATABASE);
  if (!existsSync(file)) {
    io.error(
      `No office at ${parsed.office}: ${file} does not exist. Point --office at an office directory.`,
    );
    return 1;
  }
  const now = dependencies.now ?? ((): Date => new Date());
  const board = openOfficeBoard(file);
  try {
    if (parsed.once) {
      for (const line of renderBoard(board, now())) io.output(line);
      return 0;
    }
    return await runInteractive(board, parsed.office, now, io);
  } finally {
    board.close();
  }
}

const BOARD_HELP = [
  "Commands:",
  "  o <ticket>            show a ticket and its recent events",
  "  c <ticket> <text>     comment on a ticket",
  "  a <ticket> <person>   assign a ticket to a person the office knows",
  "  x <ticket>            cancel a ticket",
  "  q                     quit",
].join("\n");

/** The board's own refusal, or any other failure, as one line. A refusal is surfaced, never swallowed. */
function refusal(error: unknown): string {
  if (error instanceof BoardError) return `The board refused (${error.kind}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** The board's current event cursor: everything on it has already been drawn. */
function lastSeq(board: Board): number {
  const events = board.eventsAfter(0);
  return events.at(-1)?.seq ?? 0;
}

/**
 * The interactive board: draw it, read a command, act, and redraw when the board's log moved.
 *
 * The person at the terminal is the office's first person. With no people on the board there is nobody
 * to act as, so the mutations that need a person are left to the board to refuse — the board's answer,
 * not a faked one.
 */
async function runInteractive(
  board: Board,
  office: string,
  now: () => Date,
  io: CliIo,
): Promise<number> {
  if (io.readLine === undefined) {
    io.error("The board needs a terminal to read commands from; pass --once to print it and exit.");
    return 1;
  }
  const draw = (): void => {
    for (const line of renderBoard(board, now())) io.output(line);
  };
  io.output(`office ${office}`);
  draw();
  io.output(BOARD_HELP);
  const operator = board.people()[0];
  io.output(
    operator === undefined
      ? "This office knows no people, so the board will refuse an assign to a person and a cancel."
      : `Acting as ${operator.name} (${operator.id}).`,
  );
  let cursor = lastSeq(board);
  for (;;) {
    const line = await io.readLine("> ");
    if (line === undefined) return 0;
    const command = line.trim();
    if (command.length === 0) continue;
    if (command === "q" || command === "quit") return 0;
    try {
      act(board, command, operator, io, now);
    } catch (error) {
      io.error(refusal(error));
    }
    const events = board.eventsAfter(cursor);
    if (events.length === 0) continue;
    cursor = events.at(-1)?.seq ?? cursor;
    io.output("");
    draw();
  }
}

/**
 * One interactive command. The mutations call the board's API, so its rules — not a copy of them —
 * decide what may happen; an unknown verb is reported rather than quietly ignored.
 */
function act(
  board: Board,
  command: string,
  operator: Person | undefined,
  io: CliIo,
  now: () => Date,
): void {
  const [verb, ...rest] = command.split(/\s+/u);
  const actor = operator?.id ?? "operator";
  if (verb === "o") {
    show(board, rest[0], io, now);
    return;
  }
  if (verb === "c") {
    const [ticket, ...words] = rest;
    if (ticket === undefined || words.length === 0) {
      throw new UsageError("c needs a ticket and a comment.");
    }
    board.comment(ticket, actor, words.join(" "));
    io.output(`Commented on ${ticket} as ${actor}.`);
    return;
  }
  if (verb === "a") {
    const [ticket, person] = rest;
    if (ticket === undefined || person === undefined) {
      throw new UsageError("a needs a ticket and a person id.");
    }
    board.assign(ticket, { kind: "person", id: person }, actor);
    io.output(`Assigned ${ticket} to ${person}, as ${actor}.`);
    return;
  }
  if (verb === "x") {
    const [ticket] = rest;
    if (ticket === undefined) throw new UsageError("x needs a ticket.");
    board.cancel(ticket, actor);
    io.output(`Cancelled ${ticket} as ${actor}.`);
    return;
  }
  throw new UsageError(`Unknown command: ${verb ?? ""}. ${BOARD_HELP}`);
}

/** A ticket and its most recent events: what it is, who holds it, and how it got here. */
function show(board: Board, ticketId: string | undefined, io: CliIo, now: () => Date): void {
  if (ticketId === undefined) throw new UsageError("o needs a ticket.");
  const ticket = board.get(ticketId);
  if (ticket === undefined) throw new UsageError(`No ticket ${ticketId} on this board.`);
  io.output(ticket.id);
  io.output(`  type      ${ticket.type}`);
  io.output(`  title     ${ticket.title}`);
  io.output(`  status    ${ticket.status}`);
  io.output(`  assignee  ${ticket.assignee ?? "unassigned"}`);
  // Where the ticket came from, stated for the person reading it: this is the same fact the relay's
  // fence carries to the model, and it is the only place on the detail view that says the text below
  // is someone else's words (RASF-3142).
  const provenance = board.provenance(ticket.id);
  if (provenance?.origin === "external") {
    io.output(
      `  origin    ${EXTERNAL_CARD_LABEL} (${provenance.sourceChannel} from ${provenance.sourceContact})`,
    );
  }
  io.output(`  age       ${formatAge(now(), ticket.updatedAt)} (updated ${ticket.updatedAt})`);
  io.output(`  created   ${ticket.createdAt}`);
  if (ticket.detail !== null) io.output(`  detail    ${ticket.detail}`);
  if (ticket.result !== null) io.output(`  result    ${ticket.result}`);
  // The card shows the used figure; this is where the ceilings and the remaining headroom live, because
  // "why did this stop" is a question about the ceiling, not about what was spent.
  const budget = board.budget(ticket.id);
  if (budget !== undefined) {
    const money = (limit: number | null, remaining: number | null): string =>
      limit === null || remaining === null
        ? "uncapped"
        : `${formatCents(limit)} (${formatCents(remaining)} left)`;
    io.output(
      `  spend     ${budget.usedCalls} calls · ${budget.usedTokens} tokens · ${formatCents(budget.usedUsdCents)}`,
    );
    io.output(
      `  ceiling   ${budget.maxCalls === null ? "no call cap" : `${budget.maxCalls} calls`} · ` +
        `${money(budget.maxTokens, budget.remainingTokens)} · ` +
        `${money(budget.maxUsdCents, budget.remainingUsdCents)}`,
    );
    io.output(`  hops      ${budget.hopCount}/${budget.maxHops}`);
  }
  const events = board.events(ticket.id);
  io.output(`  events    ${events.length}`);
  for (const event of events.slice(-DETAIL_EVENTS)) {
    const by = event.actor === null ? "" : ` by ${event.actor}`;
    io.output(`    ${event.seq}  ${event.kind}${by}  ${event.at}`);
  }
}
