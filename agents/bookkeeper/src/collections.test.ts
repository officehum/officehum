/**
 * The collections ledger (RASF-3128): one reminder per invoice and stage, whatever the run does
 * afterwards — a repeated round, or a restart in the middle of one.
 *
 * The tool's own tests run against a real Harness, so the ledger read is a committed snapshot and the
 * stage is recorded in the commit that returns the receipt. No network and no real model: the
 * QuickBooks client is `fakeQuickBooks` wrapped in a counter, so a test can prove which calls
 * actually reached it, and the model is the scripted provider.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  hook,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { fakeQuickBooks, type QuickBooks } from "@officehum/quickbooks";
import { addDays, type DefinedRole, localDate, type RoleBundle } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ScriptedTurn,
  scriptedProvider,
} from "../../../packages/office/src/testing/scripted-model.js";
import {
  CollectionsDoc,
  type CollectionsDocument,
  clearDispute,
  dispute,
  disputed,
} from "./collections.js";
import { loadCompanyFacts } from "./company.js";
import bookkeeper from "./index.js";
import {
  bookkeeperTools,
  type CollectionsCadence,
  collectionsCadence,
  collectionsStage,
  daysOverdue,
} from "./tools.js";

const temps: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close(BACKGROUND_CONTEXT).catch(() => {});
  }
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The zone the role counts its day in: the company's, which is not UTC's day in the evening. */
const ZONE = loadCompanyFacts().hours.timezone;

/** Whole days from the company's today, so a seeded invoice is exactly as overdue as a test says. */
const day = (offset: number): string => addDays(localDate(new Date(), ZONE), offset);

/** The fixtures are dated from the system clock (see `day`), so the tools run on it too. */
const SYSTEM_CLOCK = (): Date => new Date();

const usd = (cents: number) => ({ cents, currency: "USD" });

const DEMO_GUEST = {
  id: "customer-1",
  displayName: "Demo Guest",
  email: "guest@example.com",
  active: true,
};

const SECOND_GUEST = { id: "customer-2", displayName: "Second Guest", active: true };

const line = (description: string, quantity: number, unitPriceCents: number) => ({
  description,
  quantity,
  unitPrice: usd(unitPriceCents),
  amount: usd(Math.round(quantity * unitPriceCents)),
});

/** The cadence the manifest defaults, as the manifest's limits resolve it. */
const CADENCE_LIMITS = {
  collections_first_days: 3,
  collections_second_days: 14,
  collections_final_days: 30,
};

const CADENCE: CollectionsCadence = { firstDays: 3, secondDays: 14, finalDays: 30 };

const invoice = (id: string, dueOn: string, balanceCents: number) => ({
  id,
  customerId: "customer-1",
  number: id,
  issuedOn: day(-60),
  dueOn,
  total: usd(12000),
  balance: usd(balanceCents),
  lines: [line("On-site support", 3, 4000)],
});

/** One invoice long overdue — the firm stage — and one paid long ago. */
const overdueBooks = (): QuickBooks =>
  fakeQuickBooks({
    customers: [DEMO_GUEST],
    invoices: [invoice("1042", day(-20), 12000), invoice("1044", day(-70), 0)],
  });

/** One invoice four days overdue: past the package's friendly stage, not past a later one. */
const freshBooks = (): QuickBooks =>
  fakeQuickBooks({ customers: [DEMO_GUEST], invoices: [invoice("1042", day(-4), 12000)] });

/** A client that records what it was asked for, so a test can prove whether a call reached it. */
type Counted = {
  readonly books: QuickBooks;
  /** Every method the tool called, in order, e.g. `["getInvoice", "getCustomer", "sendInvoice"]`. */
  readonly calls: string[];
  /** How many times a send was asked for, replays included. */
  sends: number;
  /**
   * How many sends actually reached QuickBooks: one per requestId, because a repeated requestId on the
   * same endpoint gets the stored receipt back instead of a second send. This is the count a duplicate
   * would move, so it is the one a "no second reminder" test asserts on.
   */
  delivered: number;
  /** Every requestId a send was asked for, in order. */
  readonly requestIds: string[];
};

function counting(books: QuickBooks): Counted {
  const delivered = new Set<string>();
  const counted: Counted = {
    calls: [],
    sends: 0,
    delivered: 0,
    requestIds: [],
    books: {
      findCustomers: async (query) => {
        counted.calls.push("findCustomers");
        return await books.findCustomers(query);
      },
      getCustomer: async (id) => {
        counted.calls.push("getCustomer");
        return await books.getCustomer(id);
      },
      listInvoices: async (filter) => {
        counted.calls.push("listInvoices");
        return await books.listInvoices(filter);
      },
      getInvoice: async (id) => {
        counted.calls.push("getInvoice");
        return await books.getInvoice(id);
      },
      createInvoice: async (draft, options) => {
        counted.calls.push("createInvoice");
        return await books.createInvoice(draft, options);
      },
      sendInvoice: async (id, options) => {
        counted.calls.push("sendInvoice");
        counted.sends += 1;
        counted.requestIds.push(options.requestId);
        if (!delivered.has(options.requestId)) {
          delivered.add(options.requestId);
          counted.delivered += 1;
        }
        return await books.sendInvoice(id, options);
      },
      listPayments: async (filter) => {
        counted.calls.push("listPayments");
        return await books.listPayments(filter);
      },
    },
  };
  return counted;
}

/** One text channel of a result or a message, as the model reads it. */
function text(result: { output?: readonly unknown[] }): string {
  return (result.output ?? [])
    .map((block) => (block as { type?: string; text?: string }).text ?? "")
    .join("\n");
}

/** Every tool result text in a transcript, oldest first. */
function toolTexts(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) =>
      ((message as { content?: readonly unknown[] }).content ?? [])
        .map((block) => (block as { text?: string }).text ?? "")
        .join("\n"),
    );
}

/** The last tool result text, which is what the model acts on next. */
function lastToolText(messages: readonly Message[]): string {
  return toolTexts(messages).at(-1) ?? "";
}

/** The last thing the model said, as the run's answer. */
function lastAnswer(messages: readonly Message[]): string {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  return ((last as { content?: readonly unknown[] } | undefined)?.content ?? [])
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

/** The tools one role bundle exposes, wrapped exactly as the harness sees them. */
function toolNamed(role: { readonly extensions: readonly Extension[] }, name: string) {
  const tool = role.extensions
    .flatMap((extension) => extension.tools ?? [])
    .find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the role has no ${name} tool`);
  return tool as ToolRegistration;
}

function registryOf(extensions: readonly Extension[]) {
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  return registry;
}

/** A Harness with one root conversation, and the invocation API one tool call runs under. */
async function withHarness(): Promise<{
  readonly harness: Harness;
  readonly root: Conversation;
  readonly api: (callId: string) => ToolExecutionApi;
}> {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  harnesses.push(harness);
  const root = await harness.root(BACKGROUND_CONTEXT, {});
  return {
    harness,
    root,
    api: (callId) =>
      ({
        conversationId: root.id,
        taskId: 1,
        callId,
        commit: harness.commit.bind(harness),
        snapshot: harness.snapshot.bind(harness),
      }) as unknown as ToolExecutionApi,
  };
}

/**
 * A person's own write to the ledger: the module API, committed on the run's conversation the way a
 * host's script would. No tool reaches `dispute` or `clearDispute`, which is why the tests call them
 * here rather than through the model.
 */
async function asPerson(
  harness: Harness,
  conversationId: Conversation["id"],
  work: (ledger: CollectionsDocument) => void,
): Promise<void> {
  await harness.commit(async (tx) => {
    work(await tx.doc(CollectionsDoc, conversationId));
  }, BACKGROUND_CONTEXT);
}

/** The person who marks the disputes in these tests. */
const ADA = "ada@example.com";

/** One invoice forty days overdue: every stage of the cadence has arrived. */
const finishedBooks = (): QuickBooks =>
  fakeQuickBooks({ customers: [DEMO_GUEST], invoices: [invoice("1042", day(-40), 12000)] });

/**
 * The role with one extra hook: `tool` has finished — its stage is committed — and the run then
 * hangs, which is exactly where a killed process would leave it.
 */
function pauseAfter(role: DefinedRole, tool: string, reached: () => void): RoleBundle {
  const pause = hook(ToolTask, {
    afterTool: async (call, result, _api, context) => {
      if (call.name !== tool) return result;
      reached();
      await awaitWithContext(new Promise<never>(() => {}), context);
      return result;
    },
  });
  const [first, ...rest] = role.extensions;
  if (first === undefined) throw new Error("the role returned no extension");
  const extensions = [{ ...first, hooks: [...(first.hooks ?? []), pause] }, ...rest];
  return { extensions, agent: { ...role.agent, extensions } };
}

/**
 * A client that hangs after QuickBooks has taken the send, never returning until the run's context is
 * aborted: that is a process killed between the reminder going out and the ledger recording it. The
 * context is the one `send_reminder` runs under, which closing the harness aborts.
 */
function hangAfterSend(
  books: QuickBooks,
  reached: () => void,
  running: () => Context | undefined,
): QuickBooks {
  let first = true;
  return {
    ...books,
    sendInvoice: async (id: string, options: { requestId: string; to?: string }) => {
      const receipt = await books.sendInvoice(id, options);
      if (!first) return receipt;
      first = false;
      reached();
      const context = running();
      if (context === undefined) return receipt;
      return await awaitWithContext(new Promise<never>(() => {}), context);
    },
  };
}

/** The role, with the context one tool runs under visible to the client that hangs inside it. */
function withToolContext(role: DefinedRole, tool: string, seen: { current?: Context }): RoleBundle {
  const capture = hook(ToolTask, {
    beforeTool: (call, _api, context) => {
      if (call.name === tool) seen.current = context;
    },
  });
  const [first, ...rest] = role.extensions;
  if (first === undefined) throw new Error("the role returned no extension");
  const extensions = [{ ...first, hooks: [...(first.hooks ?? []), capture] }, ...rest];
  return { extensions, agent: { ...role.agent, extensions } };
}

/**
 * A collections round, repeated: list the overdue invoices, chase them, then report. It reads the
 * transcript, because one conversation runs the round twice and a fixed list of turns would have to
 * predict everything the first one said.
 */
function collectionsRound(messages: readonly Message[]): ScriptedTurn {
  const turns = messages
    .slice(lastInput(messages) + 1)
    .filter((message) => message.role === "assistant").length;
  if (turns === 0) {
    return { toolCalls: [{ name: "list_invoices", args: { status: "overdue" } }] };
  }
  if (turns === 1) {
    return { toolCalls: [{ name: "send_reminder", args: { invoice: "1042", tone: "firm" } }] };
  }
  return {
    text: toolTexts(messages).some((value) => value.includes("already had its"))
      ? "Nothing was sent this time: the reminder for invoice 1042 was already recorded."
      : "One firm reminder went out for invoice 1042.",
  };
}

/** Where the current round starts: the newest input the conversation was given. */
function lastInput(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

describe("the collections ledger", () => {
  it("records the stage with the receipt, and answers the same stage without touching QuickBooks", async () => {
    const counted = counting(overdueBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);

    const sent = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("remind-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(sent)).toContain("Sent a firm reminder for invoice 1042 to guest@example.com");
    expect(text(sent)).toContain("balance 120.00 USD");
    expect(sent.details).toMatchObject({
      sent: true,
      alreadySent: false,
      tone: "firm",
      to: "guest@example.com",
    });
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.sent).toHaveLength(1);
    expect(ledger?.sent[0]).toMatchObject({
      invoiceId: "1042",
      reference: "1042",
      tone: "firm",
      to: "guest@example.com",
    });

    // The same invoice and stage again, from a different call: answered from the ledger, and the
    // client is not asked anything at all.
    const reached = [...counted.calls];
    const again = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("remind-2"),
      BACKGROUND_CONTEXT,
    );
    expect(text(again)).toContain("already had its firm reminder recorded on");
    expect(text(again)).toContain("nothing was sent again");
    expect(again.details).toMatchObject({
      sent: false,
      alreadySent: true,
      tone: "firm",
      to: "guest@example.com",
    });
    expect(counted.calls).toEqual(reached);
    expect(counted.sends).toBe(1);

    // The number a person quotes, where the ledger holds the id: still one invoice, still no second
    // reminder — this one resolves the invoice, then answers from the ledger.
    const byNumber = await tools.getInvoice.execute(
      { invoice: "1042" },
      api("read-1"),
      BACKGROUND_CONTEXT,
    );
    expect(byNumber.details).toMatchObject({ found: true, invoice: { id: "1042" } });
  });

  it("refuses a stage the invoice's age has passed: one reminder, at the stage that is due", async () => {
    const counted = counting(overdueBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);

    // Twenty days overdue is the firm stage. The friendly one is past: it is refused before the firm
    // reminder goes out and after it, so the customer gets one reminder for this invoice, not two.
    const before = await tools.sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("friendly-before"),
      BACKGROUND_CONTEXT,
    );
    expect(before.isError).toBe(true);
    expect(text(before)).toContain("is 20 days overdue");
    expect(text(before)).toContain("the firm stage is the one due");
    expect(text(before)).toContain("Nothing was sent.");
    expect(counted.sends).toBe(0);

    await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("firm"),
      BACKGROUND_CONTEXT,
    );
    const after = await tools.sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("friendly-after"),
      BACKGROUND_CONTEXT,
    );
    expect(after.isError).toBe(true);
    expect(after.details).toMatchObject({ sent: false, alreadySent: false, tone: "friendly" });
    expect(counted.sends).toBe(1);
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.sent.map((record) => record.tone)).toEqual(["firm"]);
  });

  it("says a not-yet-due invoice is due in so many days, never a negative number overdue", async () => {
    const notDue = counting(
      fakeQuickBooks({ customers: [DEMO_GUEST], invoices: [invoice("1042", day(5), 12000)] }),
    );
    const { api } = await withHarness();
    const tools = bookkeeperTools(notDue.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);
    const early = await tools.sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("not-due"),
      BACKGROUND_CONTEXT,
    );
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("Invoice 1042 is due in 5 days");
    expect(text(early)).toContain("no stage is due yet");
    expect(text(early)).not.toContain("-5");
    expect(notDue.sends).toBe(0);

    const today = counting(
      fakeQuickBooks({ customers: [DEMO_GUEST], invoices: [invoice("1042", day(0), 12000)] }),
    );
    const dueToday = await bookkeeperTools(
      today.books,
      SYSTEM_CLOCK,
      () => CADENCE_LIMITS,
      ZONE,
    ).sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("due-today"),
      BACKGROUND_CONTEXT,
    );
    expect(text(dueToday)).toContain("Invoice 1042 is due today");
  });

  it("leaves a paid invoice alone and refuses an unknown one", async () => {
    const counted = counting(overdueBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);

    const paid = await tools.sendReminder.execute(
      { invoice: "1044", tone: "final" },
      api("remind-paid"),
      BACKGROUND_CONTEXT,
    );
    expect(paid.isError).toBe(true);
    expect(text(paid)).toContain("paid");
    expect(paid.details).toMatchObject({ sent: false, alreadySent: false, tone: "final" });
    expect(counted.sends).toBe(0);

    const unknown = await tools.sendReminder.execute(
      { invoice: "9999", tone: "friendly" },
      api("remind-unknown"),
      BACKGROUND_CONTEXT,
    );
    expect(unknown.isError).toBe(true);
    expect(counted.sends).toBe(0);
    expect(await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT)).toBeUndefined();

    // A customer with no address has nowhere to send, so nothing is recorded and nothing is sent.
    const addressless = counting(
      fakeQuickBooks({
        customers: [SECOND_GUEST],
        invoices: [
          {
            id: "5001",
            customerId: "customer-2",
            issuedOn: day(-30),
            dueOn: day(-7),
            total: usd(1000),
            balance: usd(1000),
            lines: [line("Parts", 1, 1000)],
          },
        ],
      }),
    );
    const noEmail = await bookkeeperTools(
      addressless.books,
      SYSTEM_CLOCK,
      () => CADENCE_LIMITS,
      ZONE,
    ).sendReminder.execute(
      { invoice: "5001", tone: "friendly" },
      api("remind-no-email"),
      BACKGROUND_CONTEXT,
    );
    expect(noEmail.isError).toBe(true);
    expect(text(noEmail)).toContain("no email on file");
    expect(addressless.sends).toBe(0);
  });

  it("refuses a stage whose day has not arrived, and names the one that is due", async () => {
    const counted = counting(freshBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);

    const early = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("early"),
      BACKGROUND_CONTEXT,
    );
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("is 4 days overdue");
    expect(text(early)).toContain("the friendly stage is the one due");
    expect(counted.sends).toBe(0);
    expect(await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT)).toBeUndefined();

    // The friendly stage is due at four days, so it goes out and is recorded.
    const due = await tools.sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("due"),
      BACKGROUND_CONTEXT,
    );
    expect(due.details).toMatchObject({ sent: true, tone: "friendly" });
    expect(counted.sends).toBe(1);
  });

  it("sends nothing when the cadence did not resolve", async () => {
    const counted = counting(overdueBooks());
    const { api } = await withHarness();
    // A host that reads no limits — and a cadence out of order — is a cadence the code cannot read.
    const noLimits = await bookkeeperTools(counted.books, SYSTEM_CLOCK).sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("no-limits"),
      BACKGROUND_CONTEXT,
    );
    expect(noLimits.isError).toBe(true);
    expect(text(noLimits)).toContain("cadence could not be read");

    const unordered = await bookkeeperTools(counted.books, SYSTEM_CLOCK, () => ({
      ...CADENCE_LIMITS,
      collections_second_days: 2,
    })).sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("unordered"),
      BACKGROUND_CONTEXT,
    );
    expect(unordered.isError).toBe(true);
    expect(counted.sends).toBe(0);
  });
});

describe("the collections cadence", () => {
  it("is read from the business's resolved limits", () => {
    expect(collectionsCadence(CADENCE_LIMITS)).toEqual(CADENCE);
    expect(collectionsCadence({ ...CADENCE_LIMITS, collections_first_days: 6 })).toEqual({
      ...CADENCE,
      firstDays: 6,
    });
    // Unreadable: a limit missing, fractional, negative, or out of order.
    expect(collectionsCadence({})).toBeUndefined();
    expect(collectionsCadence({ ...CADENCE_LIMITS, collections_first_days: 3.5 })).toBeUndefined();
    expect(collectionsCadence({ ...CADENCE_LIMITS, collections_final_days: -1 })).toBeUndefined();
    expect(collectionsCadence({ ...CADENCE_LIMITS, collections_second_days: 1 })).toBeUndefined();
  });

  it("places an invoice by how many whole days ago it was due", () => {
    const today = "2030-02-11";
    expect(daysOverdue("2030-02-01", today)).toBe(10);
    expect(daysOverdue("2030-02-11", today)).toBe(0);
    expect(daysOverdue("2030-02-20", today)).toBe(-9);
    expect(daysOverdue("not-a-date", today)).toBeUndefined();

    expect(collectionsStage(2, CADENCE)).toBeUndefined();
    expect(collectionsStage(3, CADENCE)).toBe("friendly");
    expect(collectionsStage(13, CADENCE)).toBe("friendly");
    expect(collectionsStage(14, CADENCE)).toBe("firm");
    expect(collectionsStage(30, CADENCE)).toBe("final");
  });
});

describe("a collections round", () => {
  it("sends one reminder the first time and nothing the second, in one conversation", async () => {
    const counted = counting(overdueBooks());
    const role = bookkeeper({ quickbooks: counted.books });
    const scripted = scriptedProvider(collectionsRound);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: scripted.models, registry: registryOf(role.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: scripted.model },
    });

    const first = await root.submit(
      { type: "input", content: "Run the collections round for this morning." },
      BACKGROUND_CONTEXT,
    );
    await first.wait(BACKGROUND_CONTEXT);
    const firstView = await root.context(BACKGROUND_CONTEXT);
    expect(lastToolText(firstView.messages)).toContain("Sent a firm reminder for invoice 1042");
    expect(lastAnswer(firstView.messages)).toContain("One firm reminder went out");
    expect(counted.sends).toBe(1);

    const second = await root.submit(
      { type: "input", content: "Run the collections round again." },
      BACKGROUND_CONTEXT,
    );
    await second.wait(BACKGROUND_CONTEXT);
    const secondView = await root.context(BACKGROUND_CONTEXT);
    expect(lastToolText(secondView.messages)).toContain("already had its firm reminder");
    expect(lastAnswer(secondView.messages)).toContain("Nothing was sent this time");
    expect(counted.sends).toBe(1);
    expect(counted.calls.filter((call) => call === "sendInvoice")).toHaveLength(1);

    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.sent).toHaveLength(1);
    expect(ledger?.sent[0]).toMatchObject({ invoiceId: "1042", tone: "firm" });
  });

  it("sends no second reminder when the process dies after the commit and comes back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-bookkeeper-restart-"));
    temps.push(directory);
    const counted = counting(overdueBooks());
    const role = bookkeeper({ quickbooks: counted.books });

    let committed!: () => void;
    const killed = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const interrupted = pauseAfter(role, "send_reminder", committed);
    const first = scriptedProvider([
      { toolCalls: [{ name: "send_reminder", args: { invoice: "1042", tone: "firm" } }] },
      { text: "This turn is never reached: the process dies first." },
    ]);
    const storage = await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, {
      fsync: true,
    });
    const harness = await Harness.open(
      storage,
      { models: first.models, registry: registryOf(interrupted.extensions) },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...interrupted.agent, model: first.model },
    });
    const submission = await root.submit(
      { type: "input", content: "Chase the overdue invoice." },
      BACKGROUND_CONTEXT,
    );
    await killed;

    // Killed here: the reminder has been sent and its stage committed, but nothing else has happened.
    expect(counted.calls).toEqual(["getInvoice", "getCustomer", "sendInvoice"]);
    const before = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(before?.sent).toHaveLength(1);
    const [pending] = (await harness.inspect(BACKGROUND_CONTEXT)).submissions;
    if (pending === undefined) throw new Error("the interrupted submission is not there");
    await harness.close(BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT).catch(() => {});

    // Restarted on the same storage: the tool call recovers as interrupted, and the model retries the
    // reminder it was told may have partially run.
    const second = scriptedProvider([
      { toolCalls: [{ name: "send_reminder", args: { invoice: "1042", tone: "firm" } }] },
      { text: "The reminder was already recorded, so nothing went out again." },
    ]);
    const restarted = await Harness.open(
      await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, { fsync: true }),
      { models: second.models, registry: registryOf(role.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(restarted);
    restarted.resume();
    const resumed = await restarted.submission(pending.id, BACKGROUND_CONTEXT);
    if (resumed === undefined) throw new Error("the interrupted submission did not come back");
    const settled = await resumed.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");

    // The whole point: one reminder in QuickBooks, one record in the ledger, and the retry reached no
    // client at all — it was answered from the committed ledger.
    expect(counted.sends).toBe(1);
    expect(counted.calls).toEqual(["getInvoice", "getCustomer", "sendInvoice"]);
    const after = await restarted.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(after?.sent).toHaveLength(1);
    expect(after?.sent[0]).toMatchObject({ invoiceId: "1042", reference: "1042", tone: "firm" });
    const conversation = await restarted.conversation(root.id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("the conversation did not come back");
    const view = await conversation.context(BACKGROUND_CONTEXT);
    expect(lastToolText(view.messages)).toContain("already had its firm reminder");
    expect(lastAnswer(view.messages)).toContain("already recorded");
  });

  it("takes the cadence from the business's limits, so an overlay moves the boundary", async () => {
    const overlay = mkdtempSync(join(tmpdir(), "officehum-bookkeeper-cadence-"));
    temps.push(overlay);
    writeFileSync(
      join(overlay, "settings.json"),
      JSON.stringify({ limits: { collections_first_days: 6 } }),
    );

    // Four days overdue: past the package's friendly stage of three days...
    const asShipped = await withHarness();
    const shipped = bookkeeper({ quickbooks: freshBooks() });
    const sent = await toolNamed(shipped, "send_reminder").execute(
      { invoice: "1042", tone: "friendly" },
      asShipped.api("shipped"),
      BACKGROUND_CONTEXT,
    );
    expect(text(sent)).toContain("Sent a friendly reminder for invoice 1042");
    expect(shipped.current().limits).toMatchObject({
      collections_first_days: 3,
      collections_second_days: 14,
      collections_final_days: 30,
    });

    // ...and not past a business that waits six, so the same call now waits for its own day.
    const delayed = await withHarness();
    const waiting = bookkeeper({ quickbooks: freshBooks(), overlays: [overlay] });
    expect(waiting.current().limits).toMatchObject({ collections_first_days: 6 });
    const refused = await toolNamed(waiting, "send_reminder").execute(
      { invoice: "1042", tone: "friendly" },
      delayed.api("delayed"),
      BACKGROUND_CONTEXT,
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("is 4 days overdue");
    expect(text(refused)).toContain("no stage is due yet");
    expect(
      await delayed.harness.snapshot(CollectionsDoc, delayed.root.id, BACKGROUND_CONTEXT),
    ).toBeUndefined();
  });
});

describe("a reminder's identity (RASF-3393)", () => {
  it("sends no second reminder when the process dies between the send and the ledger commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "officehum-bookkeeper-mid-send-"));
    temps.push(directory);
    const counted = counting(overdueBooks());

    let sent!: () => void;
    const reached = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const seen: { current?: Context } = {};
    const role = bookkeeper({ quickbooks: hangAfterSend(counted.books, sent, () => seen.current) });
    const interrupted = withToolContext(role, "send_reminder", seen);
    const first = scriptedProvider([
      { toolCalls: [{ name: "send_reminder", args: { invoice: "1042", tone: "firm" } }] },
      { text: "This turn is never reached: the process dies mid-send." },
    ]);
    const harness = await Harness.open(
      await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, { fsync: true }),
      { models: first.models, registry: registryOf(interrupted.extensions) },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...interrupted.agent, model: first.model },
    });
    const submission = await root.submit(
      { type: "input", content: "Chase the overdue invoice." },
      BACKGROUND_CONTEXT,
    );
    await reached;

    // Killed here: QuickBooks has the reminder, and the ledger has nothing, because the commit that
    // would record it has not run.
    expect(counted.delivered).toBe(1);
    expect(counted.calls).toEqual(["getInvoice", "getCustomer", "sendInvoice"]);
    expect(await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT)).toBeUndefined();
    const [pending] = (await harness.inspect(BACKGROUND_CONTEXT)).submissions;
    if (pending === undefined) throw new Error("the interrupted submission is not there");
    await harness.close(BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT).catch(() => {});

    // Restarted on the same storage. The interrupted submission comes back, and the model retries the
    // reminder it has no record of — a fresh call, with a call identity of its own.
    const second = scriptedProvider([
      { toolCalls: [{ name: "send_reminder", args: { invoice: "1042", tone: "firm" } }] },
      { text: "The reminder is recorded now." },
    ]);
    const restarted = await Harness.open(
      await openNodeJsonlStorage(join(directory, "harness"), BACKGROUND_CONTEXT, { fsync: true }),
      { models: second.models, registry: registryOf(role.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(restarted);
    restarted.resume();
    const resumed = await restarted.submission(pending.id, BACKGROUND_CONTEXT);
    if (resumed === undefined) throw new Error("the interrupted submission did not come back");
    const settled = await resumed.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");

    // The retry asked again, because no ledger had the stage — and got the first send back, because
    // the requestId is the invoice and the stage rather than the call that carries it. One reminder
    // reached the customer; one attempt recorded it.
    expect(counted.sends).toBe(2);
    expect(counted.delivered).toBe(1);
    expect(new Set(counted.requestIds).size).toBe(1);
    const after = await restarted.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(after?.sent).toHaveLength(1);
    expect(after?.sent[0]).toMatchObject({ invoiceId: "1042", reference: "1042", tone: "firm" });
    expect(after?.sent[0]?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const conversation = await restarted.conversation(root.id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("the conversation did not come back");
    const view = await conversation.context(BACKGROUND_CONTEXT);
    expect(lastToolText(view.messages)).toContain("Sent a firm reminder for invoice 1042");
    expect(lastToolText(view.messages)).toContain("balance 120.00 USD");
  });

  it("sends nothing again when another conversation retries the same invoice and stage", async () => {
    const counted = counting(overdueBooks());
    // One conversation's run...
    const first = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);
    const sent = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      first.api("firm-first"),
      BACKGROUND_CONTEXT,
    );
    expect(sent.details).toMatchObject({ sent: true, tone: "firm" });
    expect(counted.delivered).toBe(1);

    // ...and a different conversation, whose ledger starts empty, retrying the same stage. Its call
    // identity differs, so only the requestId can keep this to one reminder.
    const second = await withHarness();
    const again = await bookkeeperTools(
      counted.books,
      SYSTEM_CLOCK,
      () => CADENCE_LIMITS,
      ZONE,
    ).sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      second.api("firm-second"),
      BACKGROUND_CONTEXT,
    );
    expect(counted.sends).toBe(2);
    expect(counted.delivered).toBe(1);
    expect(new Set(counted.requestIds).size).toBe(1);
    // QuickBooks answered with the receipt it already held, so the stage is reported as sent, and the
    // second conversation now holds its own record of it.
    expect(again.details).toMatchObject({ sent: true, alreadySent: false, tone: "firm" });
    const ledger = await second.harness.snapshot(
      CollectionsDoc,
      second.root.id,
      BACKGROUND_CONTEXT,
    );
    expect(ledger?.sent).toHaveLength(1);
    expect(ledger?.sent[0]).toMatchObject({ invoiceId: "1042", tone: "firm" });
  });

  it("still sends a genuinely different stage, once the invoice's age reaches it", async () => {
    const counted = counting(freshBooks());
    const { harness, root, api } = await withHarness();
    // Four days overdue: the friendly stage.
    const friendly = await bookkeeperTools(
      counted.books,
      SYSTEM_CLOCK,
      () => CADENCE_LIMITS,
      ZONE,
    ).sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("friendly"),
      BACKGROUND_CONTEXT,
    );
    expect(friendly.details).toMatchObject({ sent: true, tone: "friendly" });

    // Sixteen days on the invoice is twenty days overdue: the firm stage, its own send.
    const later = (): Date => new Date(Date.now() + 16 * 86_400_000);
    const firm = await bookkeeperTools(
      counted.books,
      later,
      () => CADENCE_LIMITS,
      ZONE,
    ).sendReminder.execute({ invoice: "1042", tone: "firm" }, api("firm"), BACKGROUND_CONTEXT);
    expect(firm.details).toMatchObject({ sent: true, tone: "firm" });
    expect(counted.delivered).toBe(2);
    expect(new Set(counted.requestIds).size).toBe(2);
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    // One record per stage: the invoice is chased once at friendly and once at firm, never twice.
    expect(ledger?.sent.map((record) => record.tone)).toEqual(["friendly", "firm"]);
  });
});

/**
 * A collections run over an invoice a person has disputed: it lists what is overdue, tries to chase
 * the one invoice, and reports what the tools said. The last turn is worded from the transcript, the
 * way a model grounds its summary in what the tools returned.
 */
function disputedRound(messages: readonly Message[]): ScriptedTurn {
  const turns = messages
    .slice(lastInput(messages) + 1)
    .filter((message) => message.role === "assistant").length;
  if (turns === 0) {
    return { toolCalls: [{ name: "list_invoices", args: { status: "overdue" } }] };
  }
  if (turns === 1) {
    return { toolCalls: [{ name: "send_reminder", args: { invoice: "1042", tone: "firm" } }] };
  }
  const texts = toolTexts(messages);
  const refused = texts.find((value) => value.includes("is in dispute"));
  return {
    text:
      refused === undefined
        ? "One firm reminder went out for invoice 1042."
        : `Invoice 1042 is in dispute and was left alone. ${refused}`,
  };
}

describe("a disputed invoice (RASF-3394)", () => {
  it("gets no reminder at any stage, and every refusal says who disputed it and why", async () => {
    const counted = counting(finishedBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);
    await asPerson(harness, root.id, (ledger) =>
      dispute(ledger, "1042", {
        reason: "The customer says the second visit was never agreed",
        by: ADA,
        at: SYSTEM_CLOCK(),
      }),
    );

    // Forty days overdue: every stage of the cadence has arrived, and every one of them is refused.
    for (const tone of ["friendly", "firm", "final"] as const) {
      const refused = await tools.sendReminder.execute(
        { invoice: "1042", tone },
        api(`disputed-${tone}`),
        BACKGROUND_CONTEXT,
      );
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("is in dispute");
      expect(text(refused)).toContain(ADA);
      expect(text(refused)).toContain("The customer says the second visit was never agreed");
      expect(refused.details).toMatchObject({
        sent: false,
        alreadySent: false,
        tone,
        disputed: { invoiceId: "1042", by: ADA },
      });
    }
    expect(counted.sends).toBe(0);
    expect(counted.delivered).toBe(0);
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.sent).toEqual([]);
    expect(ledger?.disputes).toHaveLength(1);
  });

  it("is left alone by a run, which says in its summary why", async () => {
    const counted = counting(overdueBooks());
    const role = bookkeeper({ quickbooks: counted.books });
    const scripted = scriptedProvider(disputedRound);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: scripted.models, registry: registryOf(role.extensions) },
      BACKGROUND_CONTEXT,
    );
    harnesses.push(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { ...role.agent, model: scripted.model },
    });
    await asPerson(harness, root.id, (ledger) =>
      dispute(ledger, "1042", {
        reason: "Cheque posted, not cleared",
        by: ADA,
        at: SYSTEM_CLOCK(),
      }),
    );

    const submission = await root.submit(
      { type: "input", content: "Run the collections round for this morning." },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const view = await root.context(BACKGROUND_CONTEXT);

    // The run reached the invoice, was told it is in dispute, and reported that rather than chasing or
    // quietly dropping it.
    expect(lastToolText(view.messages)).toContain("is in dispute");
    expect(lastAnswer(view.messages)).toContain("is in dispute");
    expect(lastAnswer(view.messages)).toContain(ADA);
    expect(counted.sends).toBe(0);
    expect(counted.delivered).toBe(0);
  });

  it("resumes at the stage the invoice's age calls for once a person clears it", async () => {
    const counted = counting(overdueBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, SYSTEM_CLOCK, () => CADENCE_LIMITS, ZONE);
    // Twenty days overdue: the firm stage is the one the cadence names, not the first one.
    const overdueBy = daysOverdue(day(-20), day(0));
    if (overdueBy === undefined) throw new Error("the seeded due date is not a date");
    expect(collectionsStage(overdueBy, CADENCE)).toBe("firm");

    await asPerson(harness, root.id, (ledger) =>
      dispute(ledger, "1042", {
        reason: "Customer is querying the call-out charge",
        by: ADA,
        at: SYSTEM_CLOCK(),
      }),
    );
    const refused = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("before-clear"),
      BACKGROUND_CONTEXT,
    );
    expect(refused.isError).toBe(true);
    expect(counted.sends).toBe(0);

    await asPerson(harness, root.id, (ledger) =>
      clearDispute(ledger, "1042", { by: ADA, at: SYSTEM_CLOCK() }),
    );
    const sent = await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("after-clear"),
      BACKGROUND_CONTEXT,
    );
    expect(text(sent)).toContain("Sent a firm reminder for invoice 1042 to guest@example.com");
    expect(sent.details).toMatchObject({ sent: true, tone: "firm", disputed: null });
    expect(counted.delivered).toBe(1);
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    // The stage it resumed at is the one it stopped at: the cadence did not start over.
    expect(ledger?.sent.map((record) => record.tone)).toEqual(["firm"]);
    expect(disputed(ledger, "1042")).toBeUndefined();
  });

  it("reads a ledger written before the marker and disputes nothing in it", () => {
    const record = {
      invoiceId: "1042",
      reference: "1042",
      tone: "firm",
      to: "guest@example.com",
      sentAt: "2026-10-01T09:00:00.000Z",
    } as const;
    const migrated = CollectionsDoc.definition.migrate?.({ sent: [record] }, 1);
    expect(migrated).toEqual({ sent: [record], disputes: [] });
  });

  it("still leaves a paid invoice alone, as it did before the marker existed", async () => {
    const counted = counting(overdueBooks());
    const { api } = await withHarness();
    const paid = await bookkeeperTools(
      counted.books,
      SYSTEM_CLOCK,
      () => CADENCE_LIMITS,
      ZONE,
    ).sendReminder.execute({ invoice: "1044", tone: "final" }, api("paid"), BACKGROUND_CONTEXT);
    expect(paid.isError).toBe(true);
    expect(text(paid)).toContain("it is paid");
    expect(text(paid)).not.toContain("in dispute");
    expect(paid.details).toMatchObject({ sent: false, disputed: null });
    expect(counted.delivered).toBe(0);
  });

  it("is a person's decision: no tool marks or clears one, and a mark needs a name", async () => {
    const ledger: CollectionsDocument = { sent: [], disputes: [] };
    expect(() =>
      dispute(ledger, "1042", { reason: "Not agreed", by: "   ", at: SYSTEM_CLOCK() }),
    ).toThrow(/by/);
    expect(() => dispute(ledger, "1042", { reason: " ", by: ADA, at: SYSTEM_CLOCK() })).toThrow(
      /reason/,
    );
    expect(() => clearDispute(ledger, "1042", { by: "", at: SYSTEM_CLOCK() })).toThrow(/by/);
    expect(ledger.disputes).toEqual([]);
    expect(disputed(ledger, "1042")).toBeUndefined();

    // The role's whole surface: its ten tools and the SDK's skill reader, none of which touches the
    // marker — so a dispute can only be marked or cleared by a person calling the module.
    const names = bookkeeper({ quickbooks: overdueBooks() })
      .extensions.flatMap((extension) => extension.tools ?? [])
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      "create_invoice",
      "find_customer",
      "get_invoice",
      "list_invoices",
      "list_vendor_bills",
      "pay_vendor_bill",
      "read_skill",
      "reconcile_summary",
      "record_vendor_bill",
      "send_invoice",
      "send_reminder",
    ]);
  });
});

describe("the host clock (RASF-3484)", () => {
  const LATER = new Date("2027-02-01T09:00:00.000Z");
  /** Due on a fixed day, so the days overdue depend only on the clock the role is given. */
  const fixedBooks = (): QuickBooks =>
    fakeQuickBooks({ customers: [DEMO_GUEST], invoices: [invoice("1042", "2026-10-01", 12000)] });
  const role = (books: QuickBooks) => bookkeeper({ quickbooks: books, now: () => LATER });

  it("dates a new invoice's due date from the host clock", async () => {
    const { api } = await withHarness();
    const created = await toolNamed(role(fixedBooks()), "create_invoice").execute(
      {
        customer: "customer-1",
        lines: [{ description: "On-site support", quantity: 1, unitPriceCents: 4000 }],
        dueInDays: 30,
      },
      api("create-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(created)).toContain("due 2027-03-03");
  });

  it("counts days overdue from the host clock", async () => {
    const { api } = await withHarness();
    const listed = await toolNamed(role(fixedBooks()), "list_invoices").execute(
      {},
      api("list-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(listed)).toContain("due 2026-10-01 — 123 days overdue");
  });

  it("counts the day in the company's time zone: after 16:00 Pacific it is still the Pacific date", async () => {
    // 01:30 UTC on 2 February is 17:30 on 1 February in Portland, where the company keeps its day.
    const evening = new Date("2027-02-02T01:30:00.000Z");
    const pacific = bookkeeper({ quickbooks: fixedBooks(), now: () => evening });
    const { api } = await withHarness();
    const listed = await toolNamed(pacific, "list_invoices").execute(
      {},
      api("list-evening"),
      BACKGROUND_CONTEXT,
    );
    expect(text(listed)).toContain("due 2026-10-01 — 123 days overdue");
    const created = await toolNamed(pacific, "create_invoice").execute(
      {
        customer: "customer-1",
        lines: [{ description: "On-site support", quantity: 1, unitPriceCents: 4000 }],
        dueInDays: 30,
      },
      api("create-evening"),
      BACKGROUND_CONTEXT,
    );
    expect(text(created)).toContain("due 2027-03-03");
  });

  it("stamps a reminder's sentAt from the host clock", async () => {
    const { harness, root, api } = await withHarness();
    const sent = await toolNamed(role(fixedBooks()), "send_reminder").execute(
      { invoice: "1042", tone: "final" },
      api("remind-1"),
      BACKGROUND_CONTEXT,
    );
    expect(text(sent)).toContain("Sent a final reminder");
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.sent[0]?.sentAt).toBe("2027-02-01T09:00:00.000Z");
  });

  it("stamps a person's dispute and clear marks with the time the host gives", () => {
    const ledger: CollectionsDocument = { sent: [], disputes: [] };
    const marked = dispute(ledger, "1042", { reason: "Not agreed", by: ADA, at: LATER });
    const cleared = clearDispute(ledger, "1042", {
      by: ADA,
      at: new Date("2027-02-02T10:00:00.000Z"),
    });
    expect(marked.at).toBe("2027-02-01T09:00:00.000Z");
    expect(cleared.at).toBe("2027-02-02T10:00:00.000Z");
  });
});
