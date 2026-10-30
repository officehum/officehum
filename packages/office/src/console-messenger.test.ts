import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openConsoleMessenger } from "./console-messenger.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function file(): string {
  const directory = mkdtempSync(join(tmpdir(), "officehum-console-messenger-"));
  temps.push(directory);
  return join(directory, "messages.sqlite");
}

describe("console Messenger", () => {
  it("deduplicates concurrent same-key sends across instances and reopens the stable receipt", async () => {
    const path = file();
    const first = openConsoleMessenger(path);
    const second = openConsoleMessenger(path);
    const intent = { to: "guest@example.test", channel: "email" as const, text: "Exact\ntext" };

    const [left, right] = await Promise.all([
      first.send(intent, { requestId: "conversation:task:call" }),
      second.send(intent, { requestId: "conversation:task:call" }),
    ]);
    expect(left).toEqual(right);
    expect(left).toMatchObject({ status: "recorded" });
    expect(first.messages()).toEqual([
      { requestId: "conversation:task:call", intent, delivery: left },
    ]);
    first.close();
    second.close();

    const reopened = openConsoleMessenger(path);
    expect(await reopened.send(intent, { requestId: "conversation:task:call" })).toEqual(left);
    expect(reopened.messages()).toEqual([
      { requestId: "conversation:task:call", intent, delivery: left },
    ]);
    reopened.close();
  });

  it("rejects changed intent under the same request key without another row", async () => {
    const messenger = openConsoleMessenger(file());
    await messenger.send(
      { to: "guest@example.test", channel: "email", text: "Original" },
      { requestId: "same" },
    );
    await expect(
      messenger.send(
        { to: "guest@example.test", channel: "email", text: "Changed" },
        { requestId: "same" },
      ),
    ).rejects.toThrow(/different intent/i);
    expect(messenger.messages()).toHaveLength(1);
    messenger.close();
  });

  it("rejects a mismatched stored identity and malformed stored rows", async () => {
    const identityPath = file();
    const original = openConsoleMessenger(identityPath);
    original.close();
    const identityDb = new DatabaseSync(identityPath);
    identityDb
      .prepare("UPDATE messenger_metadata SET identity = ? WHERE singleton = 1")
      .run("other");
    identityDb.close();
    expect(() => openConsoleMessenger(identityPath)).toThrow(/identity/i);

    const rowPath = file();
    const messenger = openConsoleMessenger(rowPath);
    await messenger.send(
      { to: "guest@example.test", channel: "email", text: "Original" },
      { requestId: "row" },
    );
    messenger.close();
    const rowDb = new DatabaseSync(rowPath);
    rowDb
      .prepare("UPDATE messages SET delivery_status = ? WHERE request_id = ?")
      .run("delivered", "row");
    rowDb.close();
    expect(() => openConsoleMessenger(rowPath)).toThrow(/malformed/i);
  });
});
