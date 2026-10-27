/**
 * The collections ledger: what the Bookkeeper's collections run knows that QuickBooks does not.
 *
 * Two things live here, both per conversation and both durable. First, the stages this conversation has
 * already sent, per invoice, with the time each went out — the record that makes a repeated run, a
 * retried call or a restart send nothing. Second, the invoices a *person* has put in dispute, and the
 * ones a person has taken back out: QuickBooks' `InvoiceStatus` is `open`, `overdue` or `paid` and
 * carries no dispute, so the role keeps one.
 *
 * The dispute marker is a person's, structurally: `dispute` and `clearDispute` are the only writers,
 * no tool calls them and the manifest declares no tool for them, so the model can neither declare a
 * dispute from a customer's message nor clear one to get a reminder out. A run reads the marker
 * through `disputed` and chases the invoice at no stage while it stands.
 */

import { defineDoc } from "@earendil-works/pi-durable";

/** The three tones the collections skill sends a reminder in. */
export type ReminderTone = "friendly" | "firm" | "final";

/** One reminder this conversation has sent: which invoice, at which stage, and when. */
export type ReminderSent = {
  /** The invoice's QuickBooks id, which names it whatever reference the call used. */
  invoiceId: string;
  /** The reference the call used: the id, or the document number a person or a run quoted. */
  reference: string;
  /** The stage that went out. An invoice plus a stage is what may go out only once. */
  tone: ReminderTone;
  /** The address it went to, as the customer's record held it. */
  to: string;
  /** When the stage was recorded, ISO-8601 UTC. */
  sentAt: string;
};

/**
 * One person's decision about one invoice, appended to the ledger in the order it was made: a dispute
 * put on, or taken off. The newest mark for an invoice is where that invoice stands.
 */
export type DisputeMark =
  | {
      readonly kind: "dispute";
      /** The invoice's QuickBooks id. */
      readonly invoiceId: string;
      /** Why the person says it is in dispute, in their own words. */
      readonly reason: string;
      /** Who decided it: a name or an address, never blank. */
      readonly by: string;
      /** When the decision was recorded, ISO-8601 UTC. */
      readonly at: string;
    }
  | {
      readonly kind: "clear";
      readonly invoiceId: string;
      readonly by: string;
      readonly at: string;
    };

/** A dispute that stands: the invoice, why it was marked, by whom, and when. */
export type OpenDispute = {
  readonly invoiceId: string;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
};

/** The collections ledger of one conversation: every stage sent, and every dispute a person marked. */
export type CollectionsDocument = { sent: ReminderSent[]; disputes: DisputeMark[] };

/**
 * The durable ledger that makes a collections run idempotent: per invoice, the stages this
 * conversation has already sent and when, and the disputes a person has marked. Conversation scope with
 * latest history, so a run keeps one ledger, it survives a restart, and it — never the transcript,
 * which a crash can lose — is what decides whether a reminder goes out again. A later run finds the
 * stage recorded here and sends nothing.
 *
 * Version 2 adds the disputes beside the stages sent. A version 1 ledger migrates by gaining no
 * dispute, so a conversation that predates the marker keeps every stage it recorded.
 */
export const CollectionsDoc = defineDoc<CollectionsDocument>({
  kind: "bookkeeper.collections",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ sent: [], disputes: [] }),
  migrate: (value) => ({
    sent: Array.isArray(value.sent) ? (value.sent as ReminderSent[]) : [],
    disputes: [],
  }),
});

/**
 * The stage a ledger already holds for an invoice, if it holds one. A record matches when the stage
 * is the same and either the reference this call used or the invoice's own id is the same, so the
 * document number a person quotes and the id a run lists are one invoice, not two.
 */
export function sentStage(
  sent: readonly ReminderSent[],
  reference: string,
  invoiceId: string | undefined,
  tone: ReminderTone,
): ReminderSent | undefined {
  return sent.find(
    (record) =>
      record.tone === tone &&
      (record.reference === reference ||
        (invoiceId !== undefined && record.invoiceId === invoiceId)),
  );
}

/** A name for the person behind a decision: blank is nobody, and nobody cannot decide. */
function personName(by: string): string {
  const name = by.trim();
  if (name.length === 0) {
    throw new Error("A dispute is a person's decision: say who is making it in `by`.");
  }
  return name;
}

/**
 * Marks one invoice as in dispute, appending the person's decision to the ledger and returning it.
 *
 * This is how a person stops the chase: the invoice gets no reminder at any stage until someone
 * clears the dispute. It is not a tool, so the model cannot reach it, and a customer's message that
 * claims a dispute changes nothing until a person marks one. `by` is required — a marker nobody owns is
 * worse than none.
 */
export function dispute(
  ledger: CollectionsDocument,
  invoiceId: string,
  decision: { readonly reason: string; readonly by: string },
): DisputeMark {
  const reason = decision.reason.trim();
  if (reason.length === 0) {
    throw new Error("A dispute says why: give a reason in the person's own words.");
  }
  const mark: DisputeMark = {
    kind: "dispute",
    invoiceId,
    reason,
    by: personName(decision.by),
    at: new Date().toISOString(),
  };
  ledger.disputes.push(mark);
  return mark;
}

/**
 * Takes the dispute off one invoice, so the next run chases it again at the stage its age calls for —
 * the ledger's record of what was sent is untouched, so a cleared invoice resumes where it stopped
 * rather than starting the cadence over. A person's decision, like `dispute`; no tool exposes it.
 */
export function clearDispute(
  ledger: CollectionsDocument,
  invoiceId: string,
  decision: { readonly by: string },
): DisputeMark {
  const mark: DisputeMark = {
    kind: "clear",
    invoiceId,
    by: personName(decision.by),
    at: new Date().toISOString(),
  };
  ledger.disputes.push(mark);
  return mark;
}

/** The dispute standing against one invoice, if a person's newest mark on it put one there. */
export function disputed(
  ledger: CollectionsDocument | undefined,
  invoiceId: string,
): OpenDispute | undefined {
  return disputedInvoices(ledger).find((open) => open.invoiceId === invoiceId);
}

/** Every dispute standing in one ledger, in the order a person marked them. */
export function disputedInvoices(ledger: CollectionsDocument | undefined): OpenDispute[] {
  const open = new Map<string, OpenDispute>();
  for (const mark of ledger?.disputes ?? []) {
    if (mark.kind === "clear") {
      open.delete(mark.invoiceId);
      continue;
    }
    // A later dispute replaces an earlier one: the newest reason is where the invoice stands.
    open.set(mark.invoiceId, {
      invoiceId: mark.invoiceId,
      reason: mark.reason,
      by: mark.by,
      at: mark.at,
    });
  }
  return [...open.values()];
}
