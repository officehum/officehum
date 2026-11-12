/**
 * The company record the catalog roles read: the shape of `company/default/company.json`, which
 * `npm run sync-company` copies into each role as `skills/company-handbook/references/facts.json`.
 *
 * A role types only the parts it reads, by picking them from here, so no tool can print what its
 * role never typed:
 *
 * ```ts
 * export type CompanyFacts = Pick<CompanyRecord, "profile" | "hours" | "people" | "tone">;
 * // People Ops reads no contact details at all:
 * export type Person = Omit<CompanyRecordPerson, "email" | "phone" | "department">;
 * ```
 *
 * Money is integer cents throughout, and a person is named by their `people[].id`.
 */

import type { CompanyPerson } from "./company.js";

export interface CompanyAddress {
  readonly street: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface CompanyInsurance {
  readonly kind: string;
  readonly limitCents: number;
}

/** How the headcount divides between the field and the office. */
export interface CompanyFieldStaff {
  readonly cleaningCrews: number;
  readonly cleanersPerCrew: number;
  readonly maintenanceTechnicians: number;
  readonly office: number;
}

export interface CompanyProfile {
  readonly legalName: string;
  readonly tradingName: string;
  readonly tagline: string;
  readonly founded: number;
  readonly headcount: number;
  readonly field: CompanyFieldStaff;
  readonly address: CompanyAddress;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
  readonly registration: string;
  readonly serviceArea: string;
  readonly insurance: readonly CompanyInsurance[];
  readonly clients: string;
}

export interface CompanyHours {
  /**
   * The IANA time zone the company keeps its calendar in, e.g. `America/Los_Angeles`. "Today", and
   * every notice period counted from it, is `localDate(now, hours.timezone)`.
   */
  readonly timezone: string;
  readonly office: string;
  readonly crews: string;
  readonly emergencyLine: string;
  readonly closedOn: string;
  readonly note: string;
}

/** A person as the record holds them. `CompanyPerson` is the least of this the shared helpers need. */
export interface CompanyRecordPerson extends CompanyPerson {
  /** Where they work: `office`, `maintenance`, `purchasing` or `field`. */
  readonly department: string;
  readonly email: string;
  /** As the company writes it; a verified sender's phone matches it on "+" and digits. */
  readonly phone?: string;
  readonly decides: readonly string[];
}

/** One service the company sells, and the price book lines that price it. */
export interface CompanyService {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly priceBookIds: readonly string[];
  readonly leadTimeDays: number;
}

/** One line of the price book: the only place a price comes from. */
export interface CompanyPriceBookItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPriceCents: number;
  /** The least a line of this item comes to, or `null` for none. */
  readonly minimumCents: number | null;
  readonly notes: string;
}

export interface CompanyQuoting {
  /** The weeks in a month a recurring per-visit line is counted with. */
  readonly weeksPerMonth: number;
}

/** How a service failure is put right, and who decides which remedy. */
export interface CompanyRefundPolicy {
  readonly summary: string;
  /** A re-clean is booked within this many business days of the complaint. */
  readonly recleanWindowDays: number;
  readonly serviceRecoveryCreditCents: number;
  /** Who approves a credit note. */
  readonly creditNeeds: string;
  /** Who decides money back. */
  readonly refundNeeds: string;
  /** Who owns complaints about a visit. */
  readonly complaintOwner: string;
}

export interface CompanyDiscountLadderStep {
  readonly commitmentMonths: number;
  readonly percent: number;
}

export interface CompanyDiscountPolicy {
  readonly summary: string;
  readonly approver: string;
  readonly ownerApprover: string;
  readonly ownerAbovePercent: number;
  readonly ladder: readonly CompanyDiscountLadderStep[];
}

export interface CompanyPolicies {
  readonly refunds: CompanyRefundPolicy;
  readonly discounts: CompanyDiscountPolicy;
  readonly safety: readonly string[];
  readonly dataHandling: readonly string[];
  /** What is never promised. */
  readonly commitments: readonly string[];
}

export interface CompanyTone {
  readonly summary: string;
  readonly always: readonly string[];
  readonly never: readonly string[];
}

/** A ticket type that goes to a person, not a role. */
export interface CompanyTicketRoute {
  readonly type: string;
  readonly toPersonId: string;
  readonly when: string;
}

export interface CompanyEscalationRule {
  /** What a request is about, e.g. `start-date`. */
  readonly topic: string;
  /** Who decides it. */
  readonly toPersonId: string;
  readonly when: string;
}

export interface CompanyGlossaryEntry {
  readonly term: string;
  readonly meaning: string;
}

export interface CompanyApprovalLimits {
  /** A purchase order whose total is above this needs a person's approval before it goes out. */
  readonly purchaseOrderOverCents: number;
}

/** A supplier on file; `approved` is the company's own approved-supplier list. */
export interface CompanySupplier {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly approved: boolean;
  readonly leadTimeDays: number;
  readonly contactEmail: string;
}

/** One stocked item, bought from its usual supplier at the unit cost the company records. */
export interface CompanySupplyItem {
  readonly id: string;
  readonly name: string;
  readonly supplierId: string;
  readonly unit: string;
  readonly unitCostCents: number;
  /** Reorder when the stock on hand plus on order falls to this. */
  readonly reorderPoint: number;
  /** How many to order when it does. */
  readonly reorderQuantity: number;
}

/** One crew. `members` is a headcount: the crew members themselves are not on the record. */
export interface CompanyCrew {
  readonly id: string;
  readonly name: string;
  /** Who leads it, or `null` when a cleaner from the crew does. */
  readonly leadPersonId: string | null;
  readonly members: number;
  /** Crew-hours the crew may work in one week before the rest is overtime. */
  readonly weeklyHoursCap: number;
}

export interface CompanyStaffPolicies {
  /** How many days ahead time off is asked for. */
  readonly timeOffNoticeDays: number;
  /** How far back, in days, an absence the law may protect is still recorded. */
  readonly pastAbsenceWindowDays: number;
  /** Whether overtime needs a person's approval before it is worked. */
  readonly overtimeNeedsApproval: boolean;
  readonly payQuestionsTo: string;
  /** Discipline, and so termination. */
  readonly disciplineTo: string;
  /** Leave the law may protect, and accommodation requests. */
  readonly protectedLeaveTo: string;
  /** Complaints about harassment or how someone is treated at work. */
  readonly employeeRelationsTo: string;
}

/** A customer's words the company holds on record, and may quote. */
export interface CompanyTestimonial {
  readonly quote: string;
  readonly attribution: string;
}

/** What marketing may say, and who approves the rest. */
export interface CompanyMarketing {
  readonly approverId: string;
  readonly approvedClaims: readonly string[];
  /** Absent or empty: the company holds no testimonial, and none is quoted. */
  readonly testimonials?: readonly CompanyTestimonial[];
}

/** Everything the company records. A role picks the sections it reads. */
export interface CompanyRecord {
  readonly profile: CompanyProfile;
  readonly hours: CompanyHours;
  readonly people: readonly CompanyRecordPerson[];
  readonly services: readonly CompanyService[];
  readonly priceBook: readonly CompanyPriceBookItem[];
  readonly quoting: CompanyQuoting;
  readonly policies: CompanyPolicies;
  readonly tone: CompanyTone;
  readonly ticketRoutes: readonly CompanyTicketRoute[];
  readonly escalation: readonly CompanyEscalationRule[];
  readonly glossary: readonly CompanyGlossaryEntry[];
  readonly approvalLimits: CompanyApprovalLimits;
  readonly suppliers: readonly CompanySupplier[];
  readonly supplyCatalog: readonly CompanySupplyItem[];
  readonly crews: readonly CompanyCrew[];
  readonly staffPolicies: CompanyStaffPolicies;
  readonly marketing: CompanyMarketing;
}
