/**
 * The desk: the support system this role reads clients, cases and invoices from and writes cases,
 * re-cleans, credits, escalations and closures to.
 *
 * A host binds its own — a help desk, a CRM, a ticketing system with an API — and the role never knows
 * the difference. `fakeSupportDesk` is what ships with the package: five clients, their October
 * invoices priced from the company's price book, six cases, and all the arithmetic done here, so a
 * test, an eval or a first run needs no network and no credential.
 *
 * The desk owns every number and every rule that matters. The model names a case, an invoice line and
 * a date; the desk prices the line from the price book, works out the credit, checks the re-clean
 * window, picks the person a case is escalated to, and decides whether a case may close. A refusal
 * carries a code, and the tools turn the code into the next step.
 */

import {
  type CompanyFacts,
  companyHead,
  escalationOwner,
  findPerson,
  loadCompanyFacts,
  money,
  type Person,
  person,
} from "./company.js";

/** A complaint is something that went wrong; a question is something a client wants to know. */
export type CaseKind = "complaint" | "question";

/**
 * What a case is about. `quality` and `missed_visit` are work that fell short, the cases a re-clean
 * puts right; `safety` always goes to a person.
 */
export type CaseCategory =
  | "quality"
  | "missed_visit"
  | "damage"
  | "safety"
  | "billing"
  | "staff"
  | "other";

export const CASE_CATEGORIES: readonly CaseCategory[] = [
  "quality",
  "missed_visit",
  "damage",
  "safety",
  "billing",
  "staff",
  "other",
];

/** `escalated`: handed to a person, who now owns it. */
export type CaseStatus = "open" | "escalated" | "closed";

/** Why a case goes to a person; the desk picks who from the company record. */
export type EscalationReason =
  | "safety"
  | "refund"
  | "billing"
  | "legal"
  | "data"
  | "staff"
  | "unresolved";

export const ESCALATION_REASONS: readonly EscalationReason[] = [
  "safety",
  "refund",
  "billing",
  "legal",
  "data",
  "staff",
  "unresolved",
];

export type Priority = "urgent" | "high" | "normal";

export interface Client {
  readonly id: string;
  readonly name: string;
  readonly contact: string;
  readonly email: string;
  readonly site: string;
  readonly contractId: string | null;
}

/** A client as `find_client` returns it, with how many of its cases are not closed. */
export interface ClientRecord extends Client {
  readonly openCases: number;
}

/** One line of an invoice as it was billed: a price book line and a quantity. */
export interface InvoiceLineInput {
  readonly priceBookId: string;
  readonly quantity: number;
}

/** An invoice as the billing system holds it, before the desk prices it. */
export interface InvoiceRecord {
  readonly id: string;
  readonly clientId: string;
  /** What it bills, e.g. "October 2026". */
  readonly period: string;
  readonly issuedOn: string;
  readonly lines: readonly InvoiceLineInput[];
}

/** One priced invoice line, with the credit the desk would issue on it if a person approves. */
export interface InvoiceLine {
  readonly invoiceId: string;
  /** 1-based, as it appears on the invoice. */
  readonly line: number;
  readonly priceBookId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
  /** The line total or the company's usual service-recovery credit, whichever is less. */
  readonly creditCents: number;
}

export interface Invoice {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly period: string;
  readonly issuedOn: string;
  readonly lines: readonly InvoiceLine[];
  readonly totalCents: number;
}

export interface Reclean {
  readonly date: string;
  /** Signed off by the crew. A host's system sets it; no tool here does. */
  readonly done: boolean;
  readonly bookedOn: string;
}

/**
 * A credit on a case. `waiting`: a person is still deciding a credit raised outside this
 * conversation. `issued`: approved, and a credit note exists.
 */
export interface Credit {
  readonly status: "waiting" | "issued";
  readonly invoiceId: string;
  readonly line: number;
  readonly creditCents: number;
  readonly creditNoteId: string | null;
}

export interface Escalation {
  readonly reason: EscalationReason;
  readonly toPersonId: string;
  readonly toName: string;
  readonly toTitle: string;
  readonly note: string;
  /** Who a complaint is about, as given, when it is about someone. */
  readonly about: string | null;
  readonly on: string;
}

export interface SupportCase {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly kind: CaseKind;
  readonly category: CaseCategory;
  readonly status: CaseStatus;
  readonly priority: Priority;
  readonly summary: string;
  readonly reportedBy: string;
  /** The message the case came from: its channel, sender and when. */
  readonly source: string;
  readonly openedOn: string;
  /** The company answers a complaint the same business day. */
  readonly firstResponseDue: string;
  readonly reclean: Reclean | null;
  readonly credit: Credit | null;
  readonly escalations: readonly Escalation[];
  readonly outcome: string | null;
  readonly closedOn: string | null;
}

/** A credit note the desk issued once a person approved it. */
export interface CreditNote {
  readonly id: string;
  readonly caseId: string;
  readonly clientName: string;
  readonly invoiceId: string;
  readonly line: number;
  readonly lineName: string;
  readonly creditCents: number;
  readonly issuedOn: string;
}

/** A case handed to a person. */
export interface EscalationReceipt extends Escalation {
  readonly caseId: string;
  readonly clientName: string;
  /**
   * The complaint was about the person the reason normally goes to, so it went to someone else.
   */
  readonly redirected: boolean;
}

export interface CaseFilter {
  readonly clientId?: string;
  readonly caseId?: string;
  /** `open` covers open and escalated cases: everything not closed. */
  readonly status?: "open" | "closed";
}

export interface LogCaseInput {
  readonly clientId: string;
  readonly kind: CaseKind;
  readonly category: CaseCategory;
  readonly summary: string;
  readonly reportedBy: string;
  readonly source: string;
}

export interface CreditInput {
  readonly caseId: string;
  /** The client's name as list_cases gave it, so the person approving sees who it is for. */
  readonly client: string;
  readonly invoiceId: string;
  readonly line: number;
  /** The credit as list_cases gave it; the desk issues only its own figure. */
  readonly creditCents: number;
}

export interface EscalateInput {
  readonly caseId: string;
  readonly reason: EscalationReason;
  readonly note: string;
  /** Who a complaint is about, when it is about someone. Required for `staff`. */
  readonly about?: string;
}

/** What the role needs from whatever system holds its clients, cases and invoices. */
export interface SupportDesk {
  findClient(query: string): Promise<readonly ClientRecord[]>;
  listCases(filter?: CaseFilter): Promise<readonly SupportCase[]>;
  listInvoices(clientId: string): Promise<readonly Invoice[]>;
  logCase(input: LogCaseInput, options: { readonly requestId: string }): Promise<SupportCase>;
  bookReclean(
    input: { readonly caseId: string; readonly date: string },
    options: { readonly requestId: string },
  ): Promise<SupportCase>;
  /**
   * Issues a credit note. Called only once a person approved it. The approval names the client, the
   * invoice line and the credit as the desk gave them; a host desk must refuse with `credit_changed`
   * when any of them is no longer what it would issue, so a grant never issues a credit nobody saw.
   */
  issueCredit(input: CreditInput, options: { readonly requestId: string }): Promise<CreditNote>;
  escalateCase(
    input: EscalateInput,
    options: { readonly requestId: string },
  ): Promise<EscalationReceipt>;
  resolveCase(
    input: { readonly caseId: string; readonly outcome: string },
    options: { readonly requestId: string },
  ): Promise<SupportCase>;
}

/** Why the desk refused, so a tool can say what to do next without parsing the message. */
export type DeskRefusal =
  | "not_found"
  | "invalid"
  | "closed"
  | "not_a_complaint"
  | "not_reclean"
  | "outside_window"
  | "already_booked"
  | "wrong_client"
  | "credit_changed"
  | "already_credited"
  | "credit_waiting"
  | "already_escalated"
  | "no_one"
  | "reclean_pending"
  | "not_escalated"
  | "escalated";

/** The credit the desk would issue, carried by a `credit_changed` refusal so it can be asked again. */
export interface CreditQuote {
  readonly caseId: string;
  readonly client: string;
  readonly invoiceId: string;
  readonly line: number;
  readonly creditCents: number;
}

/** A refusal the model reads: an unknown case, a date outside the window, a case not ready to close. */
export class SupportDeskError extends Error {
  readonly code: DeskRefusal;
  /** For `credit_changed`: what the desk would issue. */
  readonly quote: CreditQuote | undefined;
  /** For `credit_waiting`, `escalated` and `reclean_pending`: the case refused. */
  readonly caseId: string | undefined;

  constructor(
    code: DeskRefusal,
    message: string,
    extra: { readonly quote?: CreditQuote; readonly caseId?: string } = {},
  ) {
    super(message);
    this.name = "SupportDeskError";
    this.code = code;
    this.quote = extra.quote;
    this.caseId = extra.caseId;
  }
}

/** The demonstration clients, invoices and cases; the company's own price book and policies. */
export interface FakeSupportDeskOptions {
  readonly company?: Pick<CompanyFacts, "priceBook" | "policies" | "people" | "escalation">;
  readonly clients?: readonly Client[];
  readonly invoices?: readonly InvoiceRecord[];
  readonly cases?: readonly SupportCase[];
  /** The clock. Omitted: Monday 9 November 2026, the morning of the demonstration week. */
  readonly now?: () => Date;
}

/** Monday 9 November 2026, at the start of the office day on the US west coast. */
export const DEMO_NOW = "2026-11-09T16:00:00.000Z";

/**
 * The demonstration clients: five buildings on recurring contracts. They are demonstration data, not
 * part of the company record, and a host that binds a real desk never sees them.
 */
export function demoClients(): readonly Client[] {
  return [
    {
      id: "CL-101",
      name: "Hawthorne Family Dental",
      contact: "Grace Liu",
      email: "grace@hawthornefamilydental.example",
      site: "2,400 sq ft dental suite on SE Hawthorne Boulevard",
      contractId: "CT-301",
    },
    {
      id: "CL-102",
      name: "Little Acorns Childcare",
      contact: "Megan Shaw",
      email: "megan@littleacorns.example",
      site: "childcare centre on N Williams Avenue",
      contractId: "CT-302",
    },
    {
      id: "CL-103",
      name: "Sellwood Law Partners",
      contact: "Arthur Pell",
      email: "arthur@sellwoodlaw.example",
      site: "two office floors on SE 13th Avenue",
      contractId: "CT-303",
    },
    {
      id: "CL-104",
      name: "Burnside Property Group",
      contact: "Lena Ortiz",
      email: "lena@burnsideproperty.example",
      site: "five-storey office building on W Burnside Street",
      contractId: "CT-304",
    },
    {
      id: "CL-105",
      name: "Gateway Accounting",
      contact: "Ravi Menon",
      email: "ravi@gatewayaccounting.example",
      site: "office suite on NE Halsey Street",
      contractId: "CT-305",
    },
  ];
}

/**
 * The October 2026 invoices, issued on Monday 2 November: each line a price book id and a quantity,
 * priced by the desk. October has 22 weekdays, so a nightly weekday contract bills 22 visits.
 */
export function demoInvoices(): readonly InvoiceRecord[] {
  const october = (id: string, clientId: string, lines: readonly InvoiceLineInput[]) => ({
    id,
    clientId,
    period: "October 2026",
    issuedOn: "2026-11-02",
    lines,
  });
  return [
    october("INV-2041", "CL-101", [
      { priceBookId: "clean-office-visit", quantity: 22 },
      // Two restrooms, restocked on each of the 22 visits.
      { priceBookId: "consumables-restroom", quantity: 44 },
    ]),
    october("INV-2042", "CL-102", [
      { priceBookId: "clean-office-visit", quantity: 22 },
      // The one-off carpet extraction in both classrooms on Friday 30 October.
      { priceBookId: "floor-carpet-sqft", quantity: 1200 },
    ]),
    // Two floors of 5,200 sq ft, priced per square foot on each of the 22 visits.
    october("INV-2043", "CL-103", [{ priceBookId: "clean-office-sqft", quantity: 114400 }]),
    october("INV-2044", "CL-104", [
      // The quarterly interior glass: 120 panes billed, which the client disputes (C-304).
      { priceBookId: "window-interior-pane", quantity: 120 },
      // Lobby, corridors and restrooms, 3,600 sq ft on each of the 22 visits.
      { priceBookId: "clean-office-sqft", quantity: 79200 },
    ]),
    october("INV-2045", "CL-105", [{ priceBookId: "clean-office-visit", quantity: 22 }]),
  ];
}

/**
 * The cases on the desk on the morning of Monday 9 November 2026: one closed, and five open in
 * different states — a fresh complaint, a re-clean done and waiting for the client, a question, a
 * credit a person is still deciding, and a re-clean booked for tomorrow.
 */
export function demoCases(clients: readonly Client[] = demoClients()): readonly SupportCase[] {
  const nameOf = (id: string) => clients.find((client) => client.id === id)?.name ?? id;
  const base = (
    id: string,
    clientId: string,
    kind: CaseKind,
    category: CaseCategory,
    openedOn: string,
    summary: string,
    reportedBy: string,
    source: string,
  ) => ({
    id,
    clientId,
    clientName: nameOf(clientId),
    kind,
    category,
    status: "open" as CaseStatus,
    priority: priorityOf(kind, category),
    summary,
    reportedBy,
    source,
    openedOn,
    firstResponseDue: openedOn,
    reclean: null,
    credit: null,
    escalations: [],
    outcome: null,
    closedOn: null,
  });
  return [
    {
      ...base(
        "C-300",
        "CL-105",
        "complaint",
        "quality",
        "2026-10-19",
        "The kitchen floor was left wet and streaked after the Friday 16 October visit.",
        "Ravi Menon",
        "email from Ravi Menon, Monday 19 October",
      ),
      status: "closed",
      reclean: { date: "2026-10-21", done: true, bookedOn: "2026-10-19" },
      outcome: "Re-clean done on 21 October; Ravi Menon confirmed the kitchen floor was right.",
      closedOn: "2026-10-22",
    },
    base(
      "C-301",
      "CL-101",
      "complaint",
      "quality",
      "2026-11-06",
      "Treatment rooms 2 and 3 were not mopped and the bins were not emptied on the Thursday 5 November visit; the second time this month.",
      "Grace Liu",
      "email from Grace Liu, Friday 6 November",
    ),
    {
      ...base(
        "C-302",
        "CL-102",
        "complaint",
        "quality",
        "2026-11-02",
        "Classroom carpet still stained after the carpet extraction on Friday 30 October.",
        "Megan Shaw",
        "phone call from Megan Shaw, Monday 2 November",
      ),
      reclean: { date: "2026-11-05", done: true, bookedOn: "2026-11-02" },
    },
    base(
      "C-303",
      "CL-103",
      "question",
      "other",
      "2026-11-06",
      "Asked whether the nightly clean can add Saturday visits in December.",
      "Arthur Pell",
      "email from Arthur Pell, Friday 6 November",
    ),
    {
      ...base(
        "C-304",
        "CL-104",
        "complaint",
        "billing",
        "2026-11-04",
        "The October invoice charges 120 interior panes; the client counts 96 cleaned.",
        "Lena Ortiz",
        "email from Lena Ortiz, Wednesday 4 November",
      ),
      // Raised by hand last week and still with the person who approves credits.
      credit: {
        status: "waiting",
        invoiceId: "INV-2044",
        line: 1,
        creditCents: 15000,
        creditNoteId: null,
      },
    },
    {
      ...base(
        "C-305",
        "CL-105",
        "complaint",
        "missed_visit",
        "2026-11-04",
        "The Tuesday 3 November visit was missed; the office was not cleaned.",
        "Ravi Menon",
        "phone call from Ravi Menon, Wednesday 4 November",
      ),
      reclean: { date: "2026-11-10", done: false, bookedOn: "2026-11-04" },
    },
  ];
}

/** A safety complaint is urgent, any other complaint high, a question normal. */
function priorityOf(kind: CaseKind, category: CaseCategory): Priority {
  if (category === "safety") return "urgent";
  return kind === "complaint" ? "high" : "normal";
}

/** The categories a re-clean puts right: work that fell short. */
const RECLEAN_CATEGORIES: ReadonlySet<CaseCategory> = new Set(["quality", "missed_visit"]);

const DAY_MS = 86_400_000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || isoDate(date) !== value ? undefined : date;
}

/** `days` business days (Monday to Friday) after `from`. */
function addBusinessDays(from: string, days: number): string {
  let date = new Date(`${from}T00:00:00.000Z`);
  let left = days;
  while (left > 0) {
    date = new Date(date.getTime() + DAY_MS);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return isoDate(date);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type CaseState = Mutable<Omit<SupportCase, "escalations">> & { escalations: Escalation[] };

const REASON_TOPIC: Partial<Record<EscalationReason, string>> = {
  safety: "safety-incident",
  legal: "contract-terms",
  data: "data-and-security",
};

/** An in-memory desk: demonstration clients, invoices and cases on the company's price book. */
export function fakeSupportDesk(options: FakeSupportDeskOptions = {}): SupportDesk {
  const facts = options.company ?? loadCompanyFacts();
  const refunds = facts.policies.refunds;
  const clock = options.now ?? (() => new Date(DEMO_NOW));
  const today = () => isoDate(clock());
  const clients = [...(options.clients ?? demoClients())];
  const invoices = [...(options.invoices ?? demoInvoices())];
  const cases: CaseState[] = (options.cases ?? demoCases(clients)).map((entry) => ({
    ...entry,
    escalations: [...entry.escalations],
  }));
  // Every write is remembered by its request id, so a replayed call is answered with what it already
  // did and never writes twice.
  const logged = new Map<string, SupportCase>();
  const recleans = new Map<string, SupportCase>();
  const credits = new Map<string, CreditNote>();
  const escalations = new Map<string, EscalationReceipt>();
  const closures = new Map<string, SupportCase>();
  let creditNoteNumber = 500;

  const snapshot = (entry: CaseState): SupportCase => ({
    ...entry,
    reclean: entry.reclean === null ? null : { ...entry.reclean },
    credit: entry.credit === null ? null : { ...entry.credit },
    escalations: entry.escalations.map((escalation) => ({ ...escalation })),
  });

  const findClientById = (id: string): Client => {
    const client = clients.find(
      (candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase(),
    );
    if (client === undefined) {
      throw new SupportDeskError(
        "not_found",
        `No client has the id ${JSON.stringify(id)}. Find it with find_client. Nothing was written.`,
      );
    }
    return client;
  };

  const findCase = (id: string): CaseState => {
    const entry = cases.find((candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase());
    if (entry === undefined) {
      throw new SupportDeskError(
        "not_found",
        `No case has the number ${JSON.stringify(id)}. Find it with list_cases. Nothing was written.`,
      );
    }
    return entry;
  };

  const notClosed = (entry: CaseState): void => {
    if (entry.status === "closed") {
      throw new SupportDeskError(
        "closed",
        `${entry.id} was closed on ${entry.closedOn ?? "an earlier day"} (${entry.outcome ?? "no outcome recorded"}). A new problem is a new case: log it with log_case. Nothing was written.`,
        { caseId: entry.id },
      );
    }
  };

  const required = (value: string, what: string): string => {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new SupportDeskError("invalid", `Give ${what}. Nothing was written.`);
    }
    return trimmed;
  };

  /** Each line priced from the price book, and the credit on it: the model never supplies either. */
  const price = (record: InvoiceRecord): Invoice => {
    const lines = record.lines.map((input, index): InvoiceLine => {
      const item = facts.priceBook.find((candidate) => candidate.id === input.priceBookId);
      if (item === undefined) {
        throw new Error(`Invoice ${record.id} bills ${input.priceBookId}, not in the price book.`);
      }
      const lineTotalCents = Math.max(
        Math.round(input.quantity * item.unitPriceCents),
        item.minimumCents ?? 0,
      );
      return {
        invoiceId: record.id,
        line: index + 1,
        priceBookId: item.id,
        name: item.name,
        unit: item.unit,
        quantity: input.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents,
        creditCents: Math.min(lineTotalCents, refunds.serviceRecoveryCreditCents),
      };
    });
    return {
      id: record.id,
      clientId: record.clientId,
      clientName: clients.find((client) => client.id === record.clientId)?.name ?? record.clientId,
      period: record.period,
      issuedOn: record.issuedOn,
      lines,
      totalCents: lines.reduce((total, line) => total + line.lineTotalCents, 0),
    };
  };

  const complaint = (entry: CaseState, remedy: string): void => {
    if (entry.kind !== "complaint") {
      throw new SupportDeskError(
        "not_a_complaint",
        `${entry.id} is a question, not a complaint, so there is nothing to put right with ${remedy}. Answer the question. Nothing was written.`,
        { caseId: entry.id },
      );
    }
  };

  /** Who a reason goes to, before checking who the complaint is about. */
  const ownerFor = (reason: EscalationReason): Person | undefined => {
    const topic = REASON_TOPIC[reason];
    if (topic !== undefined) return escalationOwner(facts, topic);
    if (reason === "refund") return person(facts, refunds.refundNeeds);
    if (reason === "billing") return person(facts, refunds.creditNeeds);
    return person(facts, refunds.complaintOwner);
  };

  return {
    async findClient(query: string): Promise<readonly ClientRecord[]> {
      const wanted = query.trim().toLowerCase();
      if (wanted === "") return [];
      return clients
        .filter(
          (client) =>
            client.id.toLowerCase() === wanted ||
            client.email.toLowerCase() === wanted ||
            client.contractId?.toLowerCase() === wanted ||
            client.name.toLowerCase().includes(wanted) ||
            client.contact.toLowerCase().includes(wanted) ||
            client.site.toLowerCase().includes(wanted),
        )
        .map((client) => ({
          ...client,
          openCases: cases.filter(
            (entry) => entry.clientId === client.id && entry.status !== "closed",
          ).length,
        }));
    },

    async listCases(filter: CaseFilter = {}): Promise<readonly SupportCase[]> {
      return cases
        .filter(
          (entry) =>
            filter.caseId === undefined ||
            entry.id.toLowerCase() === filter.caseId.trim().toLowerCase(),
        )
        .filter(
          (entry) =>
            filter.clientId === undefined ||
            entry.clientId.toLowerCase() === filter.clientId.trim().toLowerCase(),
        )
        .filter(
          (entry) =>
            filter.status === undefined ||
            (filter.status === "closed" ? entry.status === "closed" : entry.status !== "closed"),
        )
        .map(snapshot);
    },

    async listInvoices(clientId: string): Promise<readonly Invoice[]> {
      return invoices
        .filter((record) => record.clientId.toLowerCase() === clientId.trim().toLowerCase())
        .map(price);
    },

    async logCase(input, { requestId }): Promise<SupportCase> {
      const prior = logged.get(requestId);
      if (prior !== undefined) return prior;

      const client = findClientById(input.clientId);
      const summary = required(input.summary, "a summary of what the client raised");
      const reportedBy = required(input.reportedBy, "who raised it (reportedBy)");
      const source = required(input.source, "the message it came from (source)");
      const highest = Math.max(300, ...cases.map((entry) => Number(entry.id.replace(/\D/g, ""))));
      const opened = today();
      const entry: CaseState = {
        id: `C-${highest + 1}`,
        clientId: client.id,
        clientName: client.name,
        kind: input.kind,
        category: input.category,
        status: "open",
        priority: priorityOf(input.kind, input.category),
        summary,
        reportedBy,
        source,
        openedOn: opened,
        firstResponseDue: opened,
        reclean: null,
        credit: null,
        escalations: [],
        outcome: null,
        closedOn: null,
      };
      cases.push(entry);
      const receipt = snapshot(entry);
      logged.set(requestId, receipt);
      return receipt;
    },

    async bookReclean(input, { requestId }): Promise<SupportCase> {
      const prior = recleans.get(requestId);
      if (prior !== undefined) return prior;

      const entry = findCase(input.caseId);
      notClosed(entry);
      complaint(entry, "a re-clean");
      if (!RECLEAN_CATEGORIES.has(entry.category)) {
        throw new SupportDeskError(
          "not_reclean",
          `${entry.id} is a ${entry.category.replace("_", " ")} complaint. A re-clean puts right a visit that fell short, and this is not one. Nothing was booked.`,
          { caseId: entry.id },
        );
      }
      if (entry.reclean !== null) {
        throw new SupportDeskError(
          "already_booked",
          `${entry.id} already has a re-clean booked for ${entry.reclean.date}${entry.reclean.done ? ", and it was done" : ""}. A case gets one re-clean; nothing more was booked.`,
          { caseId: entry.id },
        );
      }
      const date = parseDate(input.date.trim());
      if (date === undefined) {
        throw new SupportDeskError(
          "invalid",
          `${JSON.stringify(input.date)} is not a date: give it as YYYY-MM-DD. Nothing was booked.`,
          { caseId: entry.id },
        );
      }
      // The window is the company's, in business days from when the complaint was made.
      const first = today();
      const last = addBusinessDays(entry.openedOn, refunds.recleanWindowDays);
      const wanted = isoDate(date);
      if (wanted < first || wanted > last) {
        throw new SupportDeskError(
          "outside_window",
          `A re-clean for ${entry.id} must be between ${first} and ${last}: within ${refunds.recleanWindowDays} business days of the complaint on ${entry.openedOn}, and not in the past. ${wanted} is outside it. Nothing was booked.`,
          { caseId: entry.id },
        );
      }
      entry.reclean = { date: wanted, done: false, bookedOn: first };
      const receipt = snapshot(entry);
      recleans.set(requestId, receipt);
      return receipt;
    },

    async issueCredit(input, { requestId }): Promise<CreditNote> {
      const prior = credits.get(requestId);
      if (prior !== undefined) return prior;

      const entry = findCase(input.caseId);
      notClosed(entry);
      complaint(entry, "a credit");
      if (entry.credit?.status === "waiting") {
        throw new SupportDeskError(
          "credit_waiting",
          `${entry.id} already has a credit of ${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line} waiting for a person. Nothing more was credited.`,
          { caseId: entry.id },
        );
      }
      if (entry.credit !== null) {
        throw new SupportDeskError(
          "already_credited",
          `${entry.id} already has credit note ${entry.credit.creditNoteId ?? ""} for ${money(entry.credit.creditCents)} on ${entry.credit.invoiceId} line ${entry.credit.line}. A case gets one credit; nothing more was credited.`,
          { caseId: entry.id },
        );
      }
      const record = invoices.find(
        (candidate) => candidate.id.toLowerCase() === input.invoiceId.trim().toLowerCase(),
      );
      if (record === undefined) {
        throw new SupportDeskError(
          "not_found",
          `No invoice has the number ${JSON.stringify(input.invoiceId)}. list_cases shows ${entry.clientName}'s invoice lines. Nothing was credited.`,
          { caseId: entry.id },
        );
      }
      if (record.clientId !== entry.clientId) {
        throw new SupportDeskError(
          "wrong_client",
          `${record.id} is not ${entry.clientName}'s invoice, so it cannot carry a credit for ${entry.id}. list_cases shows ${entry.clientName}'s invoice lines. Nothing was credited.`,
          { caseId: entry.id },
        );
      }
      const invoice = price(record);
      const line = invoice.lines.find((candidate) => candidate.line === input.line);
      if (line === undefined) {
        throw new SupportDeskError(
          "not_found",
          `${invoice.id} has lines 1 to ${invoice.lines.length}; there is no line ${input.line}. Nothing was credited.`,
          { caseId: entry.id },
        );
      }
      // The person approved a client and an amount; anything else is not what they approved.
      const quote: CreditQuote = {
        caseId: entry.id,
        client: entry.clientName,
        invoiceId: invoice.id,
        line: line.line,
        creditCents: line.creditCents,
      };
      if (
        input.creditCents !== quote.creditCents ||
        input.client.trim().toLowerCase() !== quote.client.toLowerCase()
      ) {
        throw new SupportDeskError(
          "credit_changed",
          `The credit on ${invoice.id} line ${line.line} for ${entry.id} is ${money(quote.creditCents)} to ${quote.client}, worked out by the desk; this approval named ${JSON.stringify(input.client)} and ${Number.isFinite(input.creditCents) ? money(input.creditCents) : String(input.creditCents)}. An approval covers only the client and amount the person was shown. Nothing was credited.`,
          { quote, caseId: entry.id },
        );
      }
      creditNoteNumber += 1;
      const note: CreditNote = {
        id: `CN-${creditNoteNumber}`,
        caseId: entry.id,
        clientName: entry.clientName,
        invoiceId: invoice.id,
        line: line.line,
        lineName: line.name,
        creditCents: line.creditCents,
        issuedOn: today(),
      };
      entry.credit = {
        status: "issued",
        invoiceId: invoice.id,
        line: line.line,
        creditCents: line.creditCents,
        creditNoteId: note.id,
      };
      credits.set(requestId, note);
      return note;
    },

    async escalateCase(input, { requestId }): Promise<EscalationReceipt> {
      const prior = escalations.get(requestId);
      if (prior !== undefined) return prior;

      const entry = findCase(input.caseId);
      notClosed(entry);
      const note = required(input.note, "a note saying what the person needs to know");
      const about = input.about?.trim() || null;
      if (input.reason === "staff" && about === null) {
        throw new SupportDeskError(
          "invalid",
          "A complaint about a member of staff names who it is about (about), so it never goes to that person. Nothing was handed on.",
          { caseId: entry.id },
        );
      }
      if (entry.escalations.some((escalation) => escalation.reason === input.reason)) {
        throw new SupportDeskError(
          "already_escalated",
          `${entry.id} was already handed on for ${input.reason}. Nothing more was handed on.`,
          { caseId: entry.id },
        );
      }
      // A complaint is never handed to the person it is about: the usual owner, then the person who
      // owns complaints, then the head of the company, whoever is first and not the subject.
      const subject = about === null ? undefined : findPerson(facts, about);
      const usual = ownerFor(input.reason);
      const candidates = [usual, person(facts, refunds.complaintOwner), companyHead(facts)].filter(
        (candidate): candidate is Person => candidate !== undefined,
      );
      const owner = candidates.find((candidate) => candidate.id !== subject?.id);
      if (owner === undefined) {
        throw new SupportDeskError(
          "no_one",
          `The company record names nobody to take ${input.reason} for ${entry.id}. Nothing was handed on.`,
          { caseId: entry.id },
        );
      }
      const escalation: Escalation = {
        reason: input.reason,
        toPersonId: owner.id,
        toName: owner.name,
        toTitle: owner.title,
        note,
        about,
        on: today(),
      };
      entry.escalations.push(escalation);
      entry.status = "escalated";
      const receipt: EscalationReceipt = {
        ...escalation,
        caseId: entry.id,
        clientName: entry.clientName,
        redirected: usual !== undefined && usual.id !== owner.id,
      };
      escalations.set(requestId, receipt);
      return receipt;
    },

    async resolveCase(input, { requestId }): Promise<SupportCase> {
      const prior = closures.get(requestId);
      if (prior !== undefined) return prior;

      const entry = findCase(input.caseId);
      notClosed(entry);
      const outcome = required(
        input.outcome,
        "the outcome: what was done and what the client said",
      );
      if (entry.credit?.status === "waiting") {
        throw new SupportDeskError(
          "credit_waiting",
          `${entry.id} has a credit of ${money(entry.credit.creditCents)} waiting for a person. It stays open until they decide. Nothing was closed.`,
          { caseId: entry.id },
        );
      }
      if (entry.reclean !== null && !entry.reclean.done) {
        throw new SupportDeskError(
          "reclean_pending",
          `${entry.id} has a re-clean booked for ${entry.reclean.date} that is not done yet. Nothing was closed.`,
          { caseId: entry.id },
        );
      }
      if (entry.category === "safety" && entry.escalations.length === 0) {
        throw new SupportDeskError(
          "not_escalated",
          `${entry.id} is a safety complaint that has not been handed to a person. Nothing was closed.`,
          { caseId: entry.id },
        );
      }
      if (entry.status === "escalated") {
        const latest = entry.escalations[entry.escalations.length - 1];
        throw new SupportDeskError(
          "escalated",
          `${entry.id} was handed to ${latest === undefined ? "a person" : `${latest.toName}, ${latest.toTitle}`}, who closes it. Nothing was closed.`,
          { caseId: entry.id },
        );
      }
      entry.status = "closed";
      entry.outcome = outcome;
      entry.closedOn = today();
      const receipt = snapshot(entry);
      closures.set(requestId, receipt);
      return receipt;
    },
  };
}
