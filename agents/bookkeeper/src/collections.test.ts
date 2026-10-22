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
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import type { DefinedRole, RoleBundle } from "@officehum/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ScriptedTurn,
  scriptedProvider,
} from "../../../packages/office/src/testing/scripted-model.js";
import bookkeeper from "./index.js";
import {
  bookkeeperTools,
  type CollectionsCadence,
  CollectionsDoc,
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

/** Whole days from today in UTC, so a seeded invoice keeps the status the test expects. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
  /** How many reminders QuickBooks was actually asked to send. */
  sends: number;
};

function counting(books: QuickBooks): Counted {
  const counted: Counted = {
    calls: [],
    sends: 0,
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
    const tools = bookkeeperTools(counted.books, () => CADENCE_LIMITS);

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

  it("sends a different stage through, and records it beside the first", async () => {
    const counted = counting(overdueBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, () => CADENCE_LIMITS);

    await tools.sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("firm"),
      BACKGROUND_CONTEXT,
    );
    const friendly = await tools.sendReminder.execute(
      { invoice: "1042", tone: "friendly" },
      api("friendly"),
      BACKGROUND_CONTEXT,
    );
    expect(text(friendly)).toContain("Sent a friendly reminder for invoice 1042");
    expect(friendly.details).toMatchObject({ sent: true, alreadySent: false, tone: "friendly" });
    expect(counted.sends).toBe(2);
    const ledger = await harness.snapshot(CollectionsDoc, root.id, BACKGROUND_CONTEXT);
    expect(ledger?.sent.map((record) => record.tone)).toEqual(["firm", "friendly"]);
    // One record per stage: the invoice is chased once at firm and once at friendly, never twice.
    expect(ledger?.sent.filter((record) => record.invoiceId === "1042")).toHaveLength(2);
  });

  it("leaves a paid invoice alone and refuses an unknown one", async () => {
    const counted = counting(overdueBooks());
    const { harness, root, api } = await withHarness();
    const tools = bookkeeperTools(counted.books, () => CADENCE_LIMITS);

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
      () => CADENCE_LIMITS,
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
    const tools = bookkeeperTools(counted.books, () => CADENCE_LIMITS);

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
    const noLimits = await bookkeeperTools(counted.books).sendReminder.execute(
      { invoice: "1042", tone: "firm" },
      api("no-limits"),
      BACKGROUND_CONTEXT,
    );
    expect(noLimits.isError).toBe(true);
    expect(text(noLimits)).toContain("cadence could not be read");

    const unordered = await bookkeeperTools(counted.books, () => ({
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
    const now = new Date("2030-02-11T12:00:00.000Z");
    expect(daysOverdue("2030-02-01", now)).toBe(10);
    expect(daysOverdue("2030-02-11", now)).toBe(0);
    expect(daysOverdue("2030-02-20", now)).toBe(-9);
    expect(daysOverdue("not-a-date", now)).toBeUndefined();

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
