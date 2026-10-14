import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMessengerIdentity,
  messengerIdentityString,
  readMessengerIdentity,
} from "./messenger-identity.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "officehum-messenger-identity-"));
  temps.push(directory);
  return directory;
};

const resend = {
  version: 1 as const,
  backend: "resend" as const,
  accountId: "operator-account",
  fromEmail: "desk@example.test",
  subject: "Front Desk",
};

describe("Messenger identity", () => {
  it("binds exact authority and derives a stable credential-free identity", () => {
    const directory = temporary();
    expect(bindMessengerIdentity(directory, resend)).toEqual(resend);
    expect(readMessengerIdentity(directory)).toEqual(resend);
    expect(messengerIdentityString(resend)).toMatch(/^officehum\.resend\.v1:[0-9a-f]{64}$/);
    expect(readFileSync(join(directory, "messenger.json"), "utf8")).not.toContain("api");

    expect(() => bindMessengerIdentity(directory, { ...resend, subject: "Other" })).toThrow(
      /identity mismatch/i,
    );
    expect(readMessengerIdentity(directory)).toEqual(resend);
  });

  it("rejects malformed metadata instead of rewriting it", () => {
    const directory = temporary();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "messenger.json"), JSON.stringify({ ...resend, extra: true }));
    expect(() => readMessengerIdentity(directory)).toThrow(/malformed/i);
    expect(() => bindMessengerIdentity(directory, resend)).toThrow(/malformed/i);

    for (const invalid of [
      { ...resend, accountId: " outer " },
      { ...resend, fromEmail: "Desk@example.test" },
      { ...resend, fromEmail: "desk<desk@example.test>" },
      { ...resend, subject: "bad\u0000subject" },
    ]) {
      const other = temporary();
      expect(() => bindMessengerIdentity(other, invalid)).toThrow(/malformed/i);
    }
  });

  it("classifies identity-free historical state as console and fails closed on an email ledger", () => {
    const legacy = temporary();
    mkdirSync(join(legacy, "harness"));
    expect(() => bindMessengerIdentity(legacy, resend)).toThrow(/legacy.*console/i);
    expect(existsSync(join(legacy, "messenger.json"))).toBe(false);
    expect(bindMessengerIdentity(legacy, { version: 1, backend: "console" })).toEqual({
      version: 1,
      backend: "console",
    });
    expect(readMessengerIdentity(legacy)).toEqual({ version: 1, backend: "console" });

    const unexpected = temporary();
    const database = new DatabaseSync(join(unexpected, "email.sqlite"));
    database.exec("CREATE TABLE unexpected (value TEXT)");
    database.close();
    expect(() => bindMessengerIdentity(unexpected, resend)).toThrow(/email ledger.*metadata/i);
    expect(() => readMessengerIdentity(unexpected)).toThrow(/email ledger.*metadata/i);

    const emptyConsole = temporary();
    const messages = new DatabaseSync(join(emptyConsole, "messages.sqlite"));
    messages.exec("CREATE TABLE messages (request_id TEXT)");
    messages.close();
    expect(bindMessengerIdentity(emptyConsole, resend)).toEqual(resend);
    unlinkSync(join(emptyConsole, "messenger.json"));
  });
});
