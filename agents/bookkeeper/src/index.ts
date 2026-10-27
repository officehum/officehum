/**
 * The Bookkeeper's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import bookkeeper from "@officehum/bookkeeper";
 *
 * const role = bookkeeper({ quickbooks, approve, overlays: ["./my-bookkeeper"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt, skills, tools and approval conditions; the host brings the
 * QuickBooks connection and, optionally, the person who decides gated actions. Nothing here needs
 * Office Hum, so the same bundle runs in a bare Pi Durable harness.
 */

import { fileURLToPath } from "node:url";
import type { QuickBooks } from "@officehum/quickbooks";
import { type Approver, type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };
import { bookkeeperTools, largeInvoiceCondition, newRecipientCondition } from "./tools.js";

export {
  type BookkeeperToolset,
  bookkeeperTools,
  type CallIdentity,
  type CollectionsCadence,
  CollectionsDoc,
  type CollectionsDocument,
  collectionsCadence,
  collectionsStage,
  daysOverdue,
  findCustomerByReference,
  findInvoiceByReference,
  largeInvoiceCondition,
  newRecipientCondition,
  type ReminderSent,
  type ReminderTone,
  sentStage,
  stageRequestId,
  stageStartDay,
  writeRequestId,
} from "./tools.js";

export interface BookkeeperOptions {
  /**
   * The host's QuickBooks connection: the REST client in production, `fakeQuickBooks` in a test or an
   * eval. Optional so the role still builds on a harness with no connection — its tools and
   * conditions then refuse rather than reaching for one, exactly as a role with no approver blocks
   * its gated actions.
   */
  readonly quickbooks?: QuickBooks;
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
  /** Decides every gated action. Omitted: creating, sending and reminding are all blocked. */
  readonly approve?: Approver;
}

export default function bookkeeper(options: BookkeeperOptions): DefinedRole {
  // The collections cadence is read from the role's own resolved limits at every call, so an
  // overlay's value is what a reminder is measured against and a reload needs no rebuild. The
  // reader is bound to the role this call returns; before it exists no cadence resolves, and a
  // reminder then refuses rather than guessing a stage.
  let role: DefinedRole | undefined;
  const tools = bookkeeperTools(options.quickbooks, () => role?.current().limits ?? {});
  const created = defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    tools: [
      tools.findCustomer,
      tools.listInvoices,
      tools.getInvoice,
      tools.createInvoice,
      tools.sendInvoice,
    ],
    // The reminder belongs to the collections skill, which is where its instructions live.
    skillTools: { collections: [tools.sendReminder] },
    // Two of the three approvals need code: `large_invoice` sums the draft's lines against the
    // business's resolved limit, and `new_recipient` looks the customer up through the client. The
    // third, `final_notice`, is already a manifest condition on the tone and stays there.
    when: {
      large_invoice: largeInvoiceCondition,
      new_recipient: newRecipientCondition(options.quickbooks),
    },
    ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
  });
  role = created;
  return created;
}
