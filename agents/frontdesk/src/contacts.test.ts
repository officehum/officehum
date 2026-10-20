import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { ContactsDoc, contactTools, markContactSeen } from "./contacts.js";

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close(BACKGROUND_CONTEXT)));
});

async function setup() {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  harnesses.push(harness);
  const tools = contactTools();
  const named = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Missing ${name}`);
    return tool;
  };
  const api = (callId: string, taskId = 1) =>
    ({
      conversationId: 1,
      taskId,
      callId,
      commit: harness.commit.bind(harness),
      snapshot: harness.snapshot.bind(harness),
    }) as unknown as ToolExecutionApi;
  return { harness, named, api };
}

describe("Front Desk contacts", () => {
  it("creates, corrects, clears, and lists distinct equal-name contacts", async () => {
    const { harness, named, api } = await setup();
    const create = named("create_contact");
    const update = named("update_contact");
    const list = named("list_contacts");

    const first = await create.execute(
      { name: " Guest ", email: " GUEST@EXAMPLE.COM ", phone: "+15551234567" },
      api("create-1"),
      BACKGROUND_CONTEXT,
    );
    const second = await create.execute(
      { name: "Guest", email: "other@example.com" },
      api("create-2"),
      BACKGROUND_CONTEXT,
    );
    expect(first.details).toEqual({
      contact: {
        id: "contact-1",
        name: "Guest",
        email: "guest@example.com",
        phone: "+15551234567",
        revision: 1,
        bookingIds: [],
        lastSeenAt: null,
      },
      replayed: false,
    });
    expect(second.details).toMatchObject({ contact: { id: "contact-2", name: "Guest" } });

    await update.execute(
      { id: "contact-1", expectedRevision: 1, name: "Corrected Guest", email: null },
      api("update-1"),
      BACKGROUND_CONTEXT,
    );
    const listed = await list.execute({ query: "guest" }, api("list"), BACKGROUND_CONTEXT);
    expect(listed.details).toEqual({
      contacts: [
        {
          id: "contact-1",
          name: "Corrected Guest",
          email: null,
          phone: "+15551234567",
          revision: 2,
          bookingIds: [],
          lastSeenAt: null,
        },
        {
          id: "contact-2",
          name: "Guest",
          email: "other@example.com",
          phone: null,
          revision: 1,
          bookingIds: [],
          lastSeenAt: null,
        },
      ],
    });
    expect((await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT))?.nextId).toBe(3);
  });

  it("binds durable receipts to normalized arguments and preserves historical results", async () => {
    const { harness, named, api } = await setup();
    const create = named("create_contact");
    const update = named("update_contact");
    const shared = api("same-call", 7);
    const args = { name: "Guest", email: "GUEST@example.com" };

    const original = await create.execute(args, shared, BACKGROUND_CONTEXT);
    const replay = await create.execute(
      { name: " Guest ", email: "guest@example.com" },
      shared,
      BACKGROUND_CONTEXT,
    );
    expect(replay.details).toEqual({ ...(original.details as object), replayed: true });

    await update.execute(
      { id: "contact-1", expectedRevision: 1, name: "Corrected Guest" },
      api("correction", 7),
      BACKGROUND_CONTEXT,
    );
    const historical = await create.execute(args, shared, BACKGROUND_CONTEXT);
    expect(historical).toMatchObject({
      output: [{ type: "text", text: expect.stringMatching(/historical receipt/i) }],
      details: { contact: { name: "Guest", revision: 1 }, replayed: true },
    });
    expect((await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT))?.contacts[0]).toMatchObject({
      name: "Corrected Guest",
      revision: 2,
    });

    await expect(create.execute({ name: "Different" }, shared, BACKGROUND_CONTEXT)).rejects.toThrow(
      /different arguments/i,
    );
    await expect(
      update.execute(
        { id: "contact-1", expectedRevision: 2, name: "Different" },
        shared,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/different contact operation/i);
  });

  it("serializes duplicate-channel creates and competing revision updates", async () => {
    const { harness, named, api } = await setup();
    const create = named("create_contact");
    const update = named("update_contact");

    const creates = await Promise.allSettled([
      create.execute(
        { name: "First", email: "same@example.com" },
        api("parallel-create-1"),
        BACKGROUND_CONTEXT,
      ),
      create.execute(
        { name: "Second", email: " SAME@example.com " },
        api("parallel-create-2"),
        BACKGROUND_CONTEXT,
      ),
    ]);
    expect(creates.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const id = (await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT))?.contacts[0]?.id;
    expect(id).toBe("contact-1");

    const updates = await Promise.allSettled([
      update.execute(
        { id, expectedRevision: 1, name: "Winner A" },
        api("parallel-update-1"),
        BACKGROUND_CONTEXT,
      ),
      update.execute(
        { id, expectedRevision: 1, name: "Winner B" },
        api("parallel-update-2"),
        BACKGROUND_CONTEXT,
      ),
    ]);
    expect(updates.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    await update.execute(
      { id, expectedRevision: 2, phone: "+15557654321" },
      api("later-update"),
      BACKGROUND_CONTEXT,
    );
    expect((await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT))?.contacts[0]).toMatchObject({
      revision: 3,
      phone: "+15557654321",
    });
  });

  it("shares one contact identity across conversations and a transcript fork", async () => {
    const { harness, named } = await setup();
    const root = await harness.root(BACKGROUND_CONTEXT);
    const entry = await root.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: "contact-test-anchor",
          model: [{ role: "user", content: "anchor" }],
        }),
      BACKGROUND_CONTEXT,
    );
    const fork = await root.fork(
      entry.id,
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const api = (conversationId: number, callId: string) =>
      ({
        conversationId,
        taskId: 42,
        callId,
        commit: harness.commit.bind(harness),
        snapshot: harness.snapshot.bind(harness),
      }) as unknown as ToolExecutionApi;

    await named("create_contact").execute(
      { name: "Shared Guest" },
      api(root.id, "create"),
      BACKGROUND_CONTEXT,
    );
    await named("update_contact").execute(
      { id: "contact-1", expectedRevision: 1, name: "Fork Corrected Guest" },
      api(fork.id, "update"),
      BACKGROUND_CONTEXT,
    );
    const listed = await named("list_contacts").execute(
      {},
      api(root.id, "list"),
      BACKGROUND_CONTEXT,
    );
    expect(listed.details).toMatchObject({
      contacts: [{ id: "contact-1", name: "Fork Corrected Guest", revision: 2 }],
    });
  });

  it("rejects invalid profiles, duplicate channels, stale writes, and empty corrections", async () => {
    const { named, api } = await setup();
    const create = named("create_contact");
    const update = named("update_contact");
    await expect(
      create.execute({ name: "\u0000Guest" }, api("control"), BACKGROUND_CONTEXT),
    ).rejects.toThrow(/control/i);
    await expect(
      create.execute({ name: "Guest", email: "bad" }, api("email"), BACKGROUND_CONTEXT),
    ).rejects.toThrow(/email/i);
    await expect(
      create.execute({ name: "Guest", phone: "555-1234" }, api("phone"), BACKGROUND_CONTEXT),
    ).rejects.toThrow(/phone/i);

    await create.execute(
      { name: "Guest", email: "guest@example.com", phone: "+15551234567" },
      api("valid"),
      BACKGROUND_CONTEXT,
    );
    await expect(
      create.execute(
        { name: "Other", email: " GUEST@example.com " },
        api("duplicate"),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/contact-1/);
    await expect(
      update.execute({ id: "contact-1", expectedRevision: 1 }, api("empty"), BACKGROUND_CONTEXT),
    ).rejects.toThrow(/at least one/i);
    await expect(
      update.execute(
        { id: "contact-1", expectedRevision: 2, name: "Late" },
        api("stale"),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/revision/i);
    await expect(
      update.execute(
        { id: "missing", expectedRevision: 1, name: "Nope" },
        api("missing"),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/unknown contact/i);
  });

  it("marks a known contact seen by its exact envelope email, never by name or message text", async () => {
    const { harness, named, api } = await setup();
    await named("create_contact").execute(
      { name: "Guest", email: "guest@example.test" },
      api("create-1"),
      BACKGROUND_CONTEXT,
    );
    const marked = await harness.commit(async (tx) => {
      const state = await tx.doc(ContactsDoc);
      // An unmatched sender changes nothing; the exact authenticated address marks the contact.
      expect(
        markContactSeen(state, "STRANGER@example.test", "2030-01-15T09:00:00.000Z"),
      ).toBeUndefined();
      return markContactSeen(state, "GUEST@example.test", "2030-01-15T09:00:00.000Z");
    }, BACKGROUND_CONTEXT);
    expect(marked).toBe("contact-1");
    expect((await harness.snapshot(ContactsDoc, BACKGROUND_CONTEXT))?.contacts[0]).toMatchObject({
      revision: 1,
      lastSeenAt: "2030-01-15T09:00:00.000Z",
    });
  });
});
