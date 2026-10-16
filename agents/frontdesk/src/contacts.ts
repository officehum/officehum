import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineTool,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

export type Contact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  revision: number;
  bookingIds: string[];
};

type ContactOperation = {
  key: string;
  kind: "create" | "update";
  argsJson: string;
  contact: Contact;
};

type BookingLink = {
  key: string;
  argsJson: string;
  contactId: string;
  bookingId: string;
};

export type ContactsDocument = {
  nextId: number;
  contacts: Contact[];
  operations: ContactOperation[];
  bookingLinks: BookingLink[];
};

export const ContactsDoc = defineDoc<ContactsDocument>({
  kind: "frontdesk.contacts",
  version: 1,
  scope: "session",
  initial: () => ({ nextId: 1, contacts: [], operations: [], bookingLinks: [] }),
});

type ContactReceipt = { contact: Contact; replayed: boolean };
type BookingContactMemo = {
  argsJson: string;
  contactId: string;
  revision: number;
  name: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE = /^\+[1-9][0-9]{6,14}$/u;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function operationKey(api: ToolExecutionApi): string {
  return `${api.conversationId}:${api.taskId}:${api.callId}`;
}

function normalizedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} cannot be blank.`);
  if (normalized.length > maximum)
    throw new Error(`${label} is longer than ${maximum} characters.`);
  if (hasControlCharacter(normalized)) {
    throw new Error(`${label} cannot contain control characters.`);
  }
  return normalized;
}

function normalizedName(value: string): string {
  return normalizedText(value, "Contact name", 200);
}

function normalizedEmail(value: string): string {
  const normalized = normalizedText(value, "Contact email", 254).toLowerCase();
  if (!EMAIL.test(normalized)) throw new Error("Contact email is invalid.");
  return normalized;
}

function normalizedPhone(value: string): string {
  const normalized = normalizedText(value, "Contact phone", 16);
  if (!PHONE.test(normalized)) {
    throw new Error("Contact phone must be an international number such as +15551234567.");
  }
  return normalized;
}

function detached(contact: Contact): Contact {
  return { ...contact, bookingIds: [...contact.bookingIds] };
}

function displayContacts(contacts: readonly Contact[]): string {
  if (contacts.length === 0) return "No contacts";
  return `Contacts:\n${contacts
    .map(
      ({ id, revision, name, email, phone, bookingIds }) =>
        `${id} r${revision} — ${name} — email ${email ?? "none"} — phone ${phone ?? "none"} — bookings ${bookingIds.join(", ") || "none"}`,
    )
    .join("\n")}`;
}

function receiptResult(receipt: ContactReceipt) {
  return {
    output: [
      {
        type: "text" as const,
        text: receipt.replayed
          ? `Historical receipt for ${receipt.contact.id} at revision ${receipt.contact.revision}; use list_contacts for current state.`
          : `Saved ${receipt.contact.id} at revision ${receipt.contact.revision}.`,
      },
    ],
    details: receipt,
  };
}

function assertAvailableChannels(
  contacts: readonly Contact[],
  email: string | null,
  phone: string | null,
  exceptId?: string,
): void {
  const duplicateEmail =
    email === null
      ? undefined
      : contacts.find((contact) => contact.id !== exceptId && contact.email === email);
  if (duplicateEmail !== undefined) {
    throw new Error(`Email is already used by ${duplicateEmail.id}.`);
  }
  const duplicatePhone =
    phone === null
      ? undefined
      : contacts.find((contact) => contact.id !== exceptId && contact.phone === phone);
  if (duplicatePhone !== undefined) {
    throw new Error(`Phone is already used by ${duplicatePhone.id}.`);
  }
}

const LIST_PARAMETERS = Type.Object(
  { query: Type.Optional(Type.String({ maxLength: 254 })) },
  { additionalProperties: false },
);
const CREATE_PARAMETERS = Type.Object(
  {
    name: Type.String(),
    email: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const UPDATE_PARAMETERS = Type.Object(
  {
    id: Type.String(),
    expectedRevision: Type.Integer({ minimum: 1 }),
    name: Type.Optional(Type.String()),
    email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

/** Build the portable Front Desk contact tools; their only storage dependency is the invocation API. */
export function contactTools(): ToolRegistration[] {
  const list = defineTool({
    name: "list_contacts",
    description: "List current session contacts with exact IDs and profile revisions.",
    parameters: LIST_PARAMETERS,
    replay: "safe",
    execute: async (args, api, context) => {
      const query = args.query?.trim().toLowerCase() ?? "";
      const state = await api.snapshot(ContactsDoc, context);
      const contacts = (state?.contacts ?? [])
        .filter((contact) => {
          if (query.length === 0) return true;
          return (
            contact.id === query ||
            contact.name.toLowerCase().includes(query) ||
            contact.email?.toLowerCase().includes(query) === true ||
            contact.phone?.toLowerCase().includes(query) === true
          );
        })
        .map(detached)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        );
      return {
        output: [{ type: "text" as const, text: displayContacts(contacts) }],
        details: { contacts },
      };
    },
  });

  const create = defineTool({
    name: "create_contact",
    description: "Create one session contact after operator approval.",
    parameters: CREATE_PARAMETERS,
    replay: "safe",
    executionMode: "parallel",
    execute: async (args, api, context) => {
      const normalized = {
        name: normalizedName(args.name),
        email: args.email === undefined ? null : normalizedEmail(args.email),
        phone: args.phone === undefined ? null : normalizedPhone(args.phone),
      };
      const argsJson = JSON.stringify(normalized);
      const key = operationKey(api);
      const receipt = await api.commit(async (tx): Promise<ContactReceipt> => {
        const state = await tx.doc(ContactsDoc);
        const prior = state.operations.find((operation) => operation.key === key);
        if (prior !== undefined) {
          if (prior.kind !== "create")
            throw new Error("This call identity belongs to a different contact operation.");
          if (prior.argsJson !== argsJson)
            throw new Error("This call identity was already used with different arguments.");
          return { contact: detached(prior.contact), replayed: true };
        }
        assertAvailableChannels(state.contacts, normalized.email, normalized.phone);
        const contact: Contact = {
          id: `contact-${state.nextId}`,
          ...normalized,
          revision: 1,
          bookingIds: [],
        };
        state.nextId += 1;
        state.contacts.push(contact);
        state.operations.push({ key, kind: "create", argsJson, contact: detached(contact) });
        return { contact: detached(contact), replayed: false };
      }, context);
      return receiptResult(receipt);
    },
  });

  const update = defineTool({
    name: "update_contact",
    description: "Correct one contact at an expected profile revision after operator approval.",
    parameters: UPDATE_PARAMETERS,
    replay: "safe",
    executionMode: "parallel",
    execute: async (args, api, context) => {
      if (args.name === undefined && args.email === undefined && args.phone === undefined) {
        throw new Error("Provide at least one profile field to update.");
      }
      const id = normalizedText(args.id, "Contact ID", 254);
      const normalized = {
        id,
        expectedRevision: args.expectedRevision,
        ...(args.name === undefined ? {} : { name: normalizedName(args.name) }),
        ...(args.email === undefined
          ? {}
          : { email: args.email === null ? null : normalizedEmail(args.email) }),
        ...(args.phone === undefined
          ? {}
          : { phone: args.phone === null ? null : normalizedPhone(args.phone) }),
      };
      const argsJson = JSON.stringify(normalized);
      const key = operationKey(api);
      const receipt = await api.commit(async (tx): Promise<ContactReceipt> => {
        const state = await tx.doc(ContactsDoc);
        const prior = state.operations.find((operation) => operation.key === key);
        if (prior !== undefined) {
          if (prior.kind !== "update")
            throw new Error("This call identity belongs to a different contact operation.");
          if (prior.argsJson !== argsJson)
            throw new Error("This call identity was already used with different arguments.");
          return { contact: detached(prior.contact), replayed: true };
        }
        const contact = state.contacts.find((candidate) => candidate.id === id);
        if (contact === undefined) throw new Error(`Unknown contact ${id}.`);
        if (contact.revision !== args.expectedRevision) {
          throw new Error(
            `Contact ${id} is at revision ${contact.revision}, not expected revision ${args.expectedRevision}.`,
          );
        }
        const email = "email" in normalized ? normalized.email : contact.email;
        const phone = "phone" in normalized ? normalized.phone : contact.phone;
        assertAvailableChannels(state.contacts, email, phone, id);
        if ("name" in normalized) contact.name = normalized.name;
        if ("email" in normalized) contact.email = normalized.email;
        if ("phone" in normalized) contact.phone = normalized.phone;
        contact.revision += 1;
        const snapshot = detached(contact);
        state.operations.push({ key, kind: "update", argsJson, contact: snapshot });
        return { contact: detached(snapshot), replayed: false };
      }, context);
      return receiptResult(receipt);
    },
  });

  return [list, create, update];
}

export async function pinBookingContact(
  args: { start: string; customer: string; contactId: string },
  api: ToolExecutionApi,
  context: Context,
): Promise<BookingContactMemo> {
  const contactId = normalizedText(args.contactId, "Contact ID", 254);
  const customer = normalizedName(args.customer);
  const argsJson = JSON.stringify({ start: args.start, customer, contactId });
  const prior = await api.memo<BookingContactMemo>("frontdesk.booking-contact", context);
  if (prior !== undefined) {
    if (prior.argsJson !== argsJson || prior.contactId !== contactId) {
      throw new Error("This booking call identity was already used with different arguments.");
    }
    return prior;
  }
  const state = await api.snapshot(ContactsDoc, context);
  const contact = state?.contacts.find((candidate) => candidate.id === contactId);
  if (contact === undefined) throw new Error(`Unknown contact ${contactId}.`);
  if (customer !== contact.name) {
    throw new Error(`Customer must exactly match the current name for ${contactId}.`);
  }
  const memo = await api.memo<BookingContactMemo>(
    "frontdesk.booking-contact",
    { argsJson, contactId, revision: contact.revision, name: contact.name },
    context,
  );
  if (memo.argsJson !== argsJson || memo.contactId !== contactId) {
    throw new Error("This booking call identity was already used with different arguments.");
  }
  return memo;
}

export async function linkBookingContact(
  memo: BookingContactMemo,
  bookingId: string,
  api: ToolExecutionApi,
  context: Context,
): Promise<void> {
  const key = operationKey(api);
  await api.commit(async (tx) => {
    const state = await tx.doc(ContactsDoc);
    const prior = state.bookingLinks.find((link) => link.key === key);
    if (prior !== undefined) {
      if (
        prior.argsJson !== memo.argsJson ||
        prior.contactId !== memo.contactId ||
        prior.bookingId !== bookingId
      ) {
        throw new Error("This booking call identity is already linked to a different booking.");
      }
      return;
    }
    const contact = state.contacts.find((candidate) => candidate.id === memo.contactId);
    if (contact === undefined) throw new Error(`Unknown contact ${memo.contactId}.`);
    if (!contact.bookingIds.includes(bookingId)) {
      contact.bookingIds.push(bookingId);
      contact.bookingIds.sort((left, right) => left.localeCompare(right));
    }
    state.bookingLinks.push({
      key,
      argsJson: memo.argsJson,
      contactId: memo.contactId,
      bookingId,
    });
  }, context);
}
