/**
 * Opening an office file's named connections: no network, no real credential. The Google and
 * QuickBooks builders are replaced by recorders, and the environment is a plain object the test owns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoogleCalendarOptions } from "@officehum/google-calendar";
import { fakeCalendar } from "@officehum/google-calendar";
import { type OfficeFile, parseOfficeFile } from "@officehum/office";
import { fakeQuickBooks, type QuickBooksOptions } from "@officehum/quickbooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOOGLE_TOKEN_VARIABLE,
  openConnections,
  QUICKBOOKS_TOKEN_VARIABLE,
} from "./connections.js";

const temps: string[] = [];
afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function office(roles: readonly Record<string, unknown>[]): OfficeFile {
  const directory = mkdtempSync(join(tmpdir(), "officehum-connections-"));
  temps.push(directory);
  return parseOfficeFile({ version: 1, id: "office-1", roles }, directory);
}

const GOOGLE = {
  dir: "frontdesk",
  connections: {
    calendar: { kind: "google", calendarId: "team@example.com", decisions: "google.sqlite" },
  },
};
const BOOKS = {
  dir: "bookkeeper",
  connections: {
    quickbooks: { kind: "quickbooks", realmId: "4620816365", environment: "sandbox" },
  },
};

describe("openConnections", () => {
  it("refuses at start when a credential's variable is missing, naming every one", () => {
    expect(() => openConnections(office([GOOGLE, BOOKS]), { env: {} })).toThrowError(
      `The office file names connections that need ${GOOGLE_TOKEN_VARIABLE} and ${QUICKBOOKS_TOKEN_VARIABLE}; set them in the environment before starting the runtime.`,
    );
    expect(() =>
      openConnections(office([BOOKS]), { env: { [QUICKBOOKS_TOKEN_VARIABLE]: "  " } }),
    ).toThrowError(
      `The office file names connections that need ${QUICKBOOKS_TOKEN_VARIABLE}; set it in the environment before starting the runtime.`,
    );
  });

  it("opens a local calendar that books into its own file and needs no credential", async () => {
    const file = office([
      { dir: "frontdesk", connections: { calendar: { kind: "local", file: "calendar.sqlite" } } },
      { dir: "sales" },
    ]);
    const opened = openConnections(file, { env: {} });
    const [frontdesk, sales] = file.roles;
    if (frontdesk === undefined || sales === undefined) throw new Error("unreachable");
    expect(opened.clientsFor(sales)).toEqual({});
    const calendar = opened.clientsFor(frontdesk).calendar as {
      freeSlots(date: string): Promise<string[]>;
    };
    expect((await calendar.freeSlots("2027-03-01")).length).toBeGreaterThan(0);
    opened.close();
  });

  it("builds the Google and QuickBooks clients from the file's ids, reading the token per call", async () => {
    const env: Record<string, string | undefined> = {
      [GOOGLE_TOKEN_VARIABLE]: "first-google",
      [QUICKBOOKS_TOKEN_VARIABLE]: "first-books",
    };
    const google: GoogleCalendarOptions[] = [];
    const books: QuickBooksOptions[] = [];
    const file = office([GOOGLE, BOOKS]);
    const opened = openConnections(file, {
      env,
      createGoogleCalendar: (options) => {
        google.push(options);
        return fakeCalendar(options);
      },
      createQuickBooks: (options) => {
        books.push(options);
        return fakeQuickBooks({ customers: [], invoices: [] });
      },
    });

    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({
      calendarId: "team@example.com",
      timeZone: "UTC",
      workingHours: { start: "09:00", end: "12:00" },
      durationMinutes: 60,
    });
    expect(books[0]).toMatchObject({ realmId: "4620816365", environment: "sandbox" });
    const [frontdesk, bookkeeper] = file.roles;
    if (frontdesk === undefined || bookkeeper === undefined) throw new Error("unreachable");
    expect(Object.keys(opened.clientsFor(frontdesk))).toEqual(["calendar"]);
    expect(Object.keys(opened.clientsFor(bookkeeper))).toEqual(["quickbooks"]);

    // The value is read when a call needs it: a rotated token is used, and a removed one stops the call.
    expect(await books[0]?.getAccessToken()).toBe("first-books");
    env[QUICKBOOKS_TOKEN_VARIABLE] = "rotated";
    expect(await books[0]?.getAccessToken()).toBe("rotated");
    env[GOOGLE_TOKEN_VARIABLE] = undefined;
    await expect(google[0]?.getAccessToken()).rejects.toThrow(
      `${GOOGLE_TOKEN_VARIABLE} is no longer set, so the call was not made.`,
    );
    opened.close();
  });
});
