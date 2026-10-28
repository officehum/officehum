/**
 * `officehum board` contract tests (RASF-3134).
 *
 * The board is the board's own: these tests use a real board file in a temporary office directory and
 * a real person row, and every mutation is read back through the same door the command uses. What is
 * not real is the clock — `now` is injected — and the fixture pins each ticket's `updated_at`, so a
 * rendered board is a fixed thing this file can hold to an exact expected text.
 *
 * No network, no model, no credential: the command opens one SQLite file and nothing else.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Board, NewTicket, Ticket, TicketStatus } from "@officehum/office/board";
// The test helpers, not the host door: a host opens a board, only a test seeds a person.
import { createWorkboard, seedPerson } from "@officehum/office/board/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BOARD_COLUMN_WIDTH, BOARD_WIDTH, formatAge, renderBoard, spendFooter } from "./board.js";
import { type CliDependencies, type CliIo, runCli } from "./cli.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** One column cell plus the two spaces that follow it. */
const STRIDE = BOARD_COLUMN_WIDTH + 2;
const NOW = new Date("2026-10-26T12:00:00.000Z");
const minutes = (count: number): string => new Date(NOW.getTime() - count * 60_000).toISOString();
const hours = (count: number): string => minutes(count * 60);
const days = (count: number): string => hours(count * 24);

function officeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-board-"));
  temps.push(directory);
  return directory;
}

/** The four cells of one rendered row, at the layout's fixed offsets. */
function columnsOf(line: string): string[] {
  return [0, 1, 2, 3].map((index) =>
    line.slice(index * STRIDE, index * STRIDE + BOARD_COLUMN_WIDTH).trim(),
  );
}

/** The column a card's line sits in, or -1 when nothing on the board carries that line. */
function columnOf(lines: readonly string[], text: string): number {
  for (const line of lines) {
    const at = columnsOf(line).indexOf(text);
    if (at !== -1) return at;
  }
  return -1;
}

/** The board's own row of column headers, wherever it fell. */
function headerRow(lines: readonly string[]): string[] {
  const at = lines.findIndex((line) => line.includes("open ("));
  if (at === -1) throw new Error("the board rendered no column headers");
  return columnsOf(lines[at] ?? "");
}

/** A second handle on the board file, for the fixture facts the board API does not write. */
function withRaw<T>(file: string, work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

/**
 * Pins a ticket to one instant, so its age is the clock this file injects rather than the wall clock.
 * `status` is for the states the fixture needs without a matching command: the ticket it forces is one
 * the board itself would not have moved. Everything the board *can* do goes through the board — the
 * blocked card is made by `block`, so the board's own path is what puts it in that column.
 */
function pin(file: string, ticketId: string, at: string, status?: TicketStatus): void {
  withRaw(file, (database) => {
    database
      .prepare("UPDATE tickets SET updated_at = ?, status = COALESCE(?, status) WHERE id = ?")
      .run(at, status ?? null, ticketId);
  });
}

const PROVENANCE = {
  origin: "internal",
  sourceChannel: "test",
  sourceContact: "front-desk",
} as const;

let keyCounter = 0;

/** One ticket on a test board, through the board's own API. */
function create(board: Board, input: Partial<NewTicket> = {}): Ticket {
  keyCounter += 1;
  return board.create(
    {
      type: "job.request",
      title: "Work",
      createdBy: "front-desk",
      provenance: PROVENANCE,
      ...input,
    },
    `board-test-${keyCounter}`,
  );
}

interface Fixture {
  readonly directory: string;
  readonly file: string;
  readonly board: Board;
  readonly ids: { readonly open: string; readonly claimed: string; readonly waiting: string };
}

/**
 * A fixture office: one card in every column, three finished tickets and one cancelled one, with every
 * age pinned. The terminal tickets are what the footer counts and the columns do not show.
 */
function fixture(): Fixture {
  const directory = officeDirectory();
  const file = join(directory, "office.sqlite");
  // Seeded before the board opens, so the board knows the person the office assigns work to.
  seedPerson(file, "owner", "Pat Owner");
  const board = createWorkboard(file);

  const open = create(board, { title: "Invoice 42 unpaid" });
  const old = create(board, { type: "triage.enquiry", title: "Ada wants a slot" });
  const claimed = create(board, { type: "invoice.create", title: "Post the invoice" });
  board.claim(claimed.id, "agent:bookkeeper");
  const waiting = create(board, { type: "booking.request", title: "Confirm Tuesday" });
  board.assign(waiting.id, { kind: "person", id: "owner" }, "front-desk");
  const blocked = create(board, { type: "invoice.create", title: "VAT is missing" });
  // The board's own transition, not a hand-forced column: a blocked ticket is one that went to a person.
  board.block(blocked.id, "budget", {
    reason: "budget reached (2 calls)",
    assignee: { kind: "person", id: "owner" },
  });
  pin(file, blocked.id, hours(24));
  for (let index = 1; index <= 3; index += 1) {
    const finished = create(board, { type: "invoice.create", title: `Paid ${index}` });
    board.claim(finished.id, "agent:bookkeeper");
    board.complete(finished.id, "agent:bookkeeper", { result: "Paid." });
    pin(file, finished.id, days(4));
  }
  const cancelled = create(board, { type: "invoice.create", title: "Duplicate" });
  board.cancel(cancelled.id, "owner");
  pin(file, cancelled.id, days(5));

  pin(file, open.id, minutes(4));
  pin(file, old.id, days(3));
  pin(file, claimed.id, hours(2));
  pin(file, waiting.id, minutes(5));
  return {
    directory,
    file,
    board,
    ids: { open: open.id, claimed: claimed.id, waiting: waiting.id },
  };
}

/** A terminal that hands out queued lines, the way `run`'s tests script theirs. */
function scripted(lines: (string | undefined)[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
    readLine: async () => lines.shift(),
    readApproval: async () => undefined,
  };
  return { io, output, errors };
}

const clock: CliDependencies = { now: () => NOW };

describe("officehum board", () => {
  it("renders a fixture office's cards in the four columns and exits 0", async () => {
    const office = fixture();
    const capture = scripted([]);
    expect(await runCli(["board", "--office", office.directory, "--once"], capture.io, clock)).toBe(
      0,
    );
    expect(capture.errors).toEqual([]);
    expect(capture.output.join("\n")).toMatchSnapshot();

    // The columns are the four work-in-progress statuses, in board order.
    expect(headerRow(capture.output)).toEqual([
      "open (2)",
      "claimed (1)",
      "waiting (1)",
      "blocked (1)",
    ]);
    // Every card is in the column its status names.
    expect(columnOf(capture.output, "job.request Invoice 42 unpaid")).toBe(0);
    expect(columnOf(capture.output, "triage.enquiry Ada wants a slot")).toBe(0);
    expect(columnOf(capture.output, "invoice.create Post the invoice")).toBe(1);
    expect(columnOf(capture.output, "booking.request Confirm Tuesday")).toBe(2);
    expect(columnOf(capture.output, "invoice.create VAT is missing")).toBe(3);
    // A card carries its age and its owner on the line above its title.
    const claimed = capture.output.findIndex((line) =>
      line.includes("invoice.create Post the invoice"),
    );
    expect(columnsOf(capture.output[claimed - 1] ?? "")[1]).toBe("2h  agent:bookkeeper");
    expect(capture.output[0]).toBe(`as of ${NOW.toISOString()}`);
    office.board.close();
  });

  it("counts done and cancelled under the board instead of giving them columns", async () => {
    const office = fixture();
    const capture = scripted([]);
    await runCli(["board", "--office", office.directory, "--once"], capture.io, clock);
    const text = capture.output.join("\n");

    expect(headerRow(capture.output)).not.toContain("done");
    expect(text).not.toContain("done (");
    expect(text).not.toContain("cancelled (");
    expect(capture.output.at(-1)).toBe("done 3 · cancelled 1");
    // The finished tickets are nowhere on the cards: only the count carries them.
    expect(columnOf(capture.output, "invoice.create Paid 1")).toBe(-1);
    expect(columnOf(capture.output, "invoice.create Duplicate")).toBe(-1);
    office.board.close();
  });

  it("renders an age as 4m, 2h or 3d", () => {
    expect(formatAge(NOW, "2026-10-26T11:56:00.000Z")).toBe("4m");
    expect(formatAge(NOW, "2026-10-26T10:00:00.000Z")).toBe("2h");
    expect(formatAge(NOW, "2026-10-23T12:00:00.000Z")).toBe("3d");
    expect(formatAge(NOW, "2026-10-26T11:59:30.000Z")).toBe("30s");
    // A clock that moved backwards is not a negative age.
    expect(formatAge(NOW, "2026-10-26T12:05:00.000Z")).toBe("0s");
  });

  it("shows 4m, 2h and 3d on the board's own cards", async () => {
    const office = fixture();
    const capture = scripted([]);
    await runCli(["board", "--office", office.directory, "--once"], capture.io, clock);
    const ageOf = (card: string): string | undefined => {
      const at = capture.output.findIndex((line) => line.includes(card));
      return columnsOf(capture.output[at - 1] ?? "")[columnOf(capture.output, card)];
    };
    expect(ageOf("job.request Invoice 42 unpaid")).toContain("4m");
    expect(ageOf("triage.enquiry Ada wants a slot")).toContain("3d");
    expect(ageOf("invoice.create Post the invoice")).toContain("2h");
    office.board.close();
  });

  it("truncates a long card to its column rather than wrapping the board", () => {
    const directory = officeDirectory();
    const board = createWorkboard(join(directory, "office.sqlite"));
    create(board, {
      type: "invoice.create",
      title: "A title far longer than any one column could ever hold on a single line",
    });
    const short = create(board, { title: "Short" });
    board.claim(short.id, "agent:bookkeeper");
    const lines = renderBoard(board, NOW);

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(BOARD_WIDTH);
    const card = lines.findIndex((line) => line.includes("A title far"));
    expect(card).toBeGreaterThan(-1);
    const row = lines[card] ?? "";
    // The card is cut with an ellipsis, and the column beside it still starts at its own offset.
    expect(columnsOf(row)[0]).toMatch(/…$/u);
    expect(columnsOf(row)[1]).toBe("job.request Short");
    board.close();
  });

  it("comments, assigns and cancels through the board, leaving each ticket changed", async () => {
    const office = fixture();
    const target = office.ids.open;
    const terminal = scripted([
      `c ${target} Needs a receipt`,
      `a ${target} owner`,
      `x ${target}`,
      "q",
    ]);
    expect(await runCli(["board", "--office", office.directory], terminal.io, clock)).toBe(0);
    expect(terminal.errors).toEqual([]);
    office.board.close();

    // A second handle on the same office: the changes are the board's, and they outlived the session.
    const reopened = createWorkboard(office.file);
    try {
      expect(reopened.get(target)).toMatchObject({ status: "cancelled", assignee: "owner" });
      expect(reopened.events(target).map((event) => event.kind)).toEqual([
        "created",
        "commented",
        "assigned",
        "cancelled",
      ]);
      // The operator is the office's person, and the comment the operator typed is on the ticket.
      expect(reopened.events(target).map((event) => event.actor)).toEqual([
        "front-desk",
        "owner",
        "owner",
        "owner",
      ]);
      expect(
        withRaw(office.file, (database) =>
          database.prepare("SELECT author, body FROM comments WHERE ticket_id = ?").all(target),
        ),
      ).toEqual([{ author: "owner", body: "Needs a receipt" }]);
    } finally {
      reopened.close();
    }
    expect(terminal.output.join("\n")).toContain(`Commented on ${target} as owner.`);
    expect(terminal.output.join("\n")).toContain(`Assigned ${target} to owner, as owner.`);
    expect(terminal.output.join("\n")).toContain(`Cancelled ${target} as owner.`);
    // The board redrew once the log moved: the header appears again after the first command.
    expect(terminal.output.filter((line) => line.startsWith("as of "))).toHaveLength(4);
  });

  it("cancels as a person, and surfaces the board's refusal of a person it does not know", async () => {
    const office = fixture();
    const unknown = scripted([`a ${office.ids.open} nobody`, "q"]);
    expect(await runCli(["board", "--office", office.directory], unknown.io, clock)).toBe(0);
    // The board's own refusal, kind and all — not a message this command made up, and not swallowed.
    expect(unknown.errors.join("\n")).toContain("The board refused (invalid_person)");
    expect(unknown.errors.join("\n")).toContain("No person nobody on this board.");
    expect(office.board.get(office.ids.open)).toMatchObject({ status: "open", assignee: null });

    const known = scripted([`x ${office.ids.open}`, "q"]);
    expect(await runCli(["board", "--office", office.directory], known.io, clock)).toBe(0);
    expect(known.errors).toEqual([]);
    expect(office.board.get(office.ids.open)?.status).toBe("cancelled");
    expect(office.board.events(office.ids.open).at(-1)).toMatchObject({
      kind: "cancelled",
      actor: "owner",
    });
    office.board.close();
  });

  it("shows each ticket's spend on its card and each agent's day under the board", async () => {
    const directory = officeDirectory();
    const file = join(directory, "office.sqlite");
    seedPerson(file, "owner", "Pat Owner");
    const board = createWorkboard(file);
    const ticket = create(board, {
      title: "Invoice 42",
      budget: { maxCalls: 4, maxTokens: 10_000 },
    });
    board.claim(ticket.id, "agent:bookkeeper");
    board.chargeUsage(ticket.id, "call-1", {
      calls: 1,
      tokens: 600,
      usdCents: 1,
      agent: "agent:bookkeeper",
    });
    board.chargeUsage(ticket.id, "call-2", { calls: 1, tokens: 600, agent: "agent:bookkeeper" });
    pin(file, ticket.id, minutes(4));

    const lines = renderBoard(board, NOW);
    // The card carries the used figure against the call cap — the ceiling that fences work with no
    // receipts — on its own line, under the title.
    const card = lines.findIndex((line) => line.includes("job.request Invoice 42"));
    expect(columnsOf(lines[card + 1] ?? "")[1]).toBe("2/4 calls · 1.2k tok · $0.01");
    // And the board totals the day per agent, from the ledger rather than from the cards.
    const today = new Date().toISOString().slice(0, 10);
    expect(lines.find((line) => line.startsWith("spend "))).toBe(
      `spend ${today}  agent:bookkeeper  2 calls · 1.2k tok · $0.01`,
    );
    // The terminal counts stay the board's last line.
    expect(lines.at(-1)).toBe("done 0 · cancelled 0");
    board.close();

    // The detail view is where the ceilings are: a person asking "why did this stop" needs the limit.
    const capture = scripted([`o ${ticket.id}`, "q"]);
    expect(await runCli(["board", "--office", directory], capture.io, clock)).toBe(0);
    const text = capture.output.join("\n");
    expect(text).toContain("  spend     2 calls · 1200 tokens · $0.01");
    expect(text).toContain("  ceiling   4 calls · $100.00 ($88.00 left) · uncapped");
    expect(text).toContain("  hops      0/4");
  });

  it("prints the newest days of spend and counts the days it leaves out", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      day: `2026-10-${String(20 - index).padStart(2, "0")}`,
      agent: "agent:bookkeeper",
      calls: index + 1,
      tokens: 1000,
      usdCents: 2,
    }));
    const lines = spendFooter(rows);
    // Seven days printed, newest first, then one line that says how many were not.
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("spend 2026-10-20  agent:bookkeeper  1 calls · 1.0k tok · $0.02");
    expect(lines[6]).toBe("spend 2026-10-14  agent:bookkeeper  7 calls · 1.0k tok · $0.02");
    expect(lines[7]).toBe("spend … 2 earlier days not shown");
    // Spend with no role behind it is named rather than dropped.
    expect(
      spendFooter([{ day: "2026-10-20", agent: null, calls: 1, tokens: 5, usdCents: 0 }]),
    ).toEqual(["spend 2026-10-20  unattributed  1 calls · 5 tok · $0.00"]);
  });

  it("needs no network and no model: its module opens one board file and names nothing else", () => {
    const source = readFileSync(fileURLToPath(new URL("./board.ts", import.meta.url)), "utf8");
    for (const forbidden of ["fetch(", "node:http", "node:net", "pi-ai", "process.env"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("refuses an office directory with no board in it rather than creating one", async () => {
    const directory = officeDirectory();
    const capture = scripted([]);
    expect(await runCli(["board", "--office", directory, "--once"], capture.io, clock)).toBe(1);
    expect(capture.errors.join("\n")).toContain("does not exist");
    expect(existsSync(join(directory, "office.sqlite"))).toBe(false);
  });

  it("rejects an unknown option as a usage error", async () => {
    const capture = scripted([]);
    expect(await runCli(["board", "--wat"], capture.io)).toBe(2);
    expect(capture.errors.join("\n")).toContain("Unknown option");
  });
});
