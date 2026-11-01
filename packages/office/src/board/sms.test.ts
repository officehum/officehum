import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openBoard } from "./index.js";

/**
 * The SMS intake store (RASF-3162): the MessageSid guard, the opt-out switch and the window counter.
 *
 * The duplicate guard is checked on a real file as well as in memory, because the property being bought
 * is that a *second delivery* is a no-op, and a second delivery is what a restart, a retry and a second
 * connection all look like.
 */
const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function boardFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-sms-"));
  temps.push(directory);
  return join(directory, "office.db");
}

const AT = "2030-01-01T00:00:00.000Z";
const NUMBER = "+15551234567";

describe("SMS intake store", () => {
  it("records a MessageSid once and reports the second delivery as a duplicate", () => {
    const file = boardFile();
    const board = openBoard(file);
    try {
      expect(board.sms.recordInboundOnce("SM1", AT)).toBe(true);
      // The same delivery again, which is what Twilio's retry is.
      expect(board.sms.recordInboundOnce("SM1", "2030-01-01T00:00:05.000Z")).toBe(false);
      // A different message is a different fact.
      expect(board.sms.recordInboundOnce("SM2", AT)).toBe(true);
    } finally {
      board.close();
    }

    const database = new DatabaseSync(file);
    try {
      expect(database.prepare("SELECT COUNT(*) AS n FROM sms_inbound").get()).toEqual({ n: 2 });
      // The first write kept its own timestamp: a retry does not rewrite the row it found.
      expect(
        database.prepare("SELECT received_at FROM sms_inbound WHERE message_sid = 'SM1'").get(),
      ).toEqual({ received_at: AT });
    } finally {
      database.close();
    }
  });

  it("keeps the duplicate guard across a reopen", () => {
    const file = boardFile();
    const first = openBoard(file);
    expect(first.sms.recordInboundOnce("SM1", AT)).toBe(true);
    first.close();

    const reopened = openBoard(file);
    try {
      expect(reopened.sms.recordInboundOnce("SM1", AT)).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("holds a number's latest word: STOP, then START", () => {
    const board = openBoard(boardFile());
    try {
      expect(board.sms.optOutOf(NUMBER)).toBeUndefined();
      board.sms.setOptOut(NUMBER, "stop", AT);
      expect(board.sms.optOutOf(NUMBER)).toBe("stop");
      board.sms.setOptOut(NUMBER, "start", "2030-01-02T00:00:00.000Z");
      expect(board.sms.optOutOf(NUMBER)).toBe("start");
      // One row per number: the state is a switch, not a log.
      expect(board.sms.optOutOf("+15559999999")).toBeUndefined();
    } finally {
      board.close();
    }
  });

  it("counts a number's window and refuses the message past the ceiling, still counting it", () => {
    const board = openBoard(boardFile());
    try {
      const window = "2030-01-01T00:00:00.000Z";
      expect(board.sms.countInWindow(NUMBER, window, 2)).toEqual({ allowed: true, count: 1 });
      expect(board.sms.countInWindow(NUMBER, window, 2)).toEqual({ allowed: true, count: 2 });
      // The third message inside the window is refused, and the count records that it arrived.
      expect(board.sms.countInWindow(NUMBER, window, 2)).toEqual({ allowed: false, count: 3 });
      expect(board.sms.countInWindow(NUMBER, window, 2)).toEqual({ allowed: false, count: 4 });
    } finally {
      board.close();
    }
  });

  it("gives another number, and another window, their own counters", () => {
    const board = openBoard(boardFile());
    try {
      const window = "2030-01-01T00:00:00.000Z";
      expect(board.sms.countInWindow(NUMBER, window, 1)).toEqual({ allowed: true, count: 1 });
      expect(board.sms.countInWindow(NUMBER, window, 1)).toEqual({ allowed: false, count: 2 });
      // A different number is unaffected by the first one's flood.
      expect(board.sms.countInWindow("+15559999999", window, 1)).toEqual({
        allowed: true,
        count: 1,
      });
      // So is the same number in the next window.
      expect(board.sms.countInWindow(NUMBER, "2030-01-01T01:00:00.000Z", 1)).toEqual({
        allowed: true,
        count: 1,
      });
    } finally {
      board.close();
    }
  });

  it("refuses empty keys and an impossible limit rather than writing a row about nothing", () => {
    const board = openBoard(boardFile());
    try {
      expect(() => board.sms.recordInboundOnce("", AT)).toThrow(/MessageSid/);
      expect(() => board.sms.recordInboundOnce("SM1", " ")).toThrow(/receive time/);
      expect(() => board.sms.setOptOut("", "stop", AT)).toThrow(/number/);
      expect(() => board.sms.optOutOf("")).toThrow(/number/);
      expect(() => board.sms.countInWindow(NUMBER, "", 3)).toThrow(/window/);
      expect(() => board.sms.countInWindow(NUMBER, AT, -1)).toThrow(/rate limit/);
      expect(() => board.sms.countInWindow(NUMBER, AT, 1.5)).toThrow(/rate limit/);
    } finally {
      board.close();
    }
  });
});
