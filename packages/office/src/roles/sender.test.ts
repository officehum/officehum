/** The verified sender a role's tools read: the board's provenance row for the conversation's ticket. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Board } from "../board/index.js";
import { createWorkboard } from "../board/testing.js";
import { boardSenderResolver } from "./sender.js";

const temps: string[] = [];
const boards: Board[] = [];

afterEach(() => {
  for (const board of boards.splice(0)) board.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshBoard(): Board {
  const dir = mkdtempSync(join(tmpdir(), "officehum-sender-"));
  temps.push(dir);
  const board = createWorkboard(join(dir, "office.sqlite"));
  boards.push(board);
  return board;
}

const GUEST = {
  origin: "external",
  sourceChannel: "email",
  sourceContact: "guest@example.test",
} as const;

describe("boardSenderResolver", () => {
  it("boardSenderResolver returns the ticket's provenance", async () => {
    const board = freshBoard();
    const ticket = board.create(
      { type: "booking.request", title: "Booking", createdBy: "frontdesk", provenance: GUEST },
      "root",
    );
    board.bindConversation(7, { ticketId: ticket.id, agent: "frontdesk" });

    expect(await boardSenderResolver(board)({ conversationId: 7, taskId: 1 })).toEqual({
      origin: "external",
      channel: "email",
      contact: "guest@example.test",
    });
  });

  it("is undefined for a conversation with no ticket", async () => {
    const resolve = boardSenderResolver(freshBoard());
    expect(await resolve({ conversationId: 8, taskId: 1 })).toBeUndefined();
    // Not a conversation id at all: nobody is asking, rather than a board error.
    expect(await resolve({ conversationId: "8", taskId: 1 })).toBeUndefined();
  });

  it("a child ticket's sender is its root's", async () => {
    const board = freshBoard();
    const root = board.create(
      { type: "booking.request", title: "Booking", createdBy: "frontdesk", provenance: GUEST },
      "root",
    );
    // The delegating agent's own provenance on the child is ignored by the board, so a delegatee
    // cannot become "the colleague asking" by dispatching the work to itself.
    const child = board.create(
      {
        type: "invoice.create",
        title: "Invoice the booking",
        createdBy: "frontdesk",
        parentId: root.id,
        provenance: { origin: "internal", sourceChannel: "agent", sourceContact: "frontdesk" },
      },
      "child",
    );
    board.bindConversation(9, { ticketId: child.id, agent: "bookkeeper" });

    expect(await boardSenderResolver(board)({ conversationId: 9, taskId: 1 })).toEqual({
      origin: "external",
      channel: "email",
      contact: "guest@example.test",
    });
  });
});
