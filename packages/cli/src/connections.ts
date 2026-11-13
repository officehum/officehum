/**
 * Opening the outside systems an office file names for its roles (RASF-3576).
 *
 * The office file says which calendar or QuickBooks company a role works in: ids and paths, never a
 * credential. This module, in the host, builds each client. A credential is read from the
 * environment on every call the client makes, so a token rotated in the shell takes effect without a
 * restart and no value is ever held in a file or passed on a command line. A variable that is missing
 * at start stops the runtime there, naming it: a role must not load looking connected and then fail
 * its first real call, and nothing falls back to demonstration data.
 */
import type { CalendarClient, GoogleCalendarOptions } from "@officehum/google-calendar";
import { createGoogleCalendar } from "@officehum/google-calendar";
import {
  createGoogleCalendarHost,
  type OfficeConnection,
  type OfficeFile,
  type OfficeFileRole,
  openLocalCalendar,
} from "@officehum/office";
import { type QuickBooks, type QuickBooksOptions, quickbooksClient } from "@officehum/quickbooks";

/** The variable a Google calendar's access token is read from: the one solo mode already uses. */
export const GOOGLE_TOKEN_VARIABLE = "GOOGLE_CALENDAR_ACCESS_TOKEN";
/** The variable a QuickBooks company's access token is read from. */
export const QUICKBOOKS_TOKEN_VARIABLE = "QUICKBOOKS_ACCESS_TOKEN";

/**
 * A Google calendar's schedule: the one solo mode binds, so the same calendar offers the same slots
 * whichever way the Front Desk is run.
 */
const GOOGLE_SCHEDULE = {
  timeZone: "UTC",
  workingHours: { start: "09:00", end: "12:00" },
  durationMinutes: 60,
} as const;

export interface ConnectionDependencies {
  /** The environment credentials are read from. Omitted: the process's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Builds the Google client; a test passes a fake. Omitted: the real one. */
  readonly createGoogleCalendar?: (options: GoogleCalendarOptions) => CalendarClient;
  /** Builds the QuickBooks client; a test passes a fake. Omitted: the real one. */
  readonly createQuickBooks?: (options: QuickBooksOptions) => QuickBooks;
}

export interface OpenedConnections {
  /** The clients built for one role's entry, by the name its factory takes each under. */
  clientsFor(role: OfficeFileRole): Readonly<Record<string, unknown>>;
  /** Closes every file a connection opened. Safe to call once the runtime has stopped. */
  close(): void;
}

/** Opens every connection the office file names, or refuses naming every missing variable at once. */
export function openConnections(
  file: OfficeFile,
  dependencies: ConnectionDependencies = {},
): OpenedConnections {
  const env = dependencies.env ?? process.env;
  const variableFor = (connection: OfficeConnection): string | undefined =>
    connection.kind === "google"
      ? GOOGLE_TOKEN_VARIABLE
      : connection.kind === "quickbooks"
        ? QUICKBOOKS_TOKEN_VARIABLE
        : undefined;

  const missing = new Set<string>();
  for (const role of file.roles) {
    for (const connection of Object.values(role.connections ?? {})) {
      const variable = variableFor(connection);
      if (variable !== undefined && !env[variable]?.trim()) missing.add(variable);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `The office file names connections that need ${[...missing].join(" and ")}; set ${missing.size === 1 ? "it" : "them"} in the environment before starting the runtime.`,
    );
  }

  /** Reads the token when a call needs it, so nothing holds the value between calls. */
  const token = (variable: string) => async (): Promise<string> => {
    const value = env[variable]?.trim();
    if (!value) throw new Error(`${variable} is no longer set, so the call was not made.`);
    return value;
  };

  const closers: (() => void)[] = [];
  const close = (): void => {
    for (const closer of closers.splice(0).reverse()) closer();
  };
  const open = (connection: OfficeConnection): unknown => {
    if (connection.kind === "local") {
      const calendar = openLocalCalendar(connection.file);
      closers.push(() => calendar.close());
      return calendar;
    }
    if (connection.kind === "google") {
      const decisions = openLocalCalendar(connection.decisions);
      closers.push(() => decisions.close());
      const client = (dependencies.createGoogleCalendar ?? createGoogleCalendar)({
        calendarId: connection.calendarId,
        getAccessToken: token(GOOGLE_TOKEN_VARIABLE),
        ...GOOGLE_SCHEDULE,
      });
      return createGoogleCalendarHost({
        client,
        decisions,
        durationMinutes: GOOGLE_SCHEDULE.durationMinutes,
      });
    }
    return (dependencies.createQuickBooks ?? quickbooksClient)({
      realmId: connection.realmId,
      environment: connection.environment,
      getAccessToken: token(QUICKBOOKS_TOKEN_VARIABLE),
    });
  };

  const byRole = new Map<OfficeFileRole, Record<string, unknown>>();
  try {
    for (const role of file.roles) {
      const clients: Record<string, unknown> = {};
      for (const [name, connection] of Object.entries(role.connections ?? {})) {
        clients[name] = open(connection);
      }
      byRole.set(role, clients);
    }
  } catch (error) {
    close();
    throw error;
  }
  return { clientsFor: (role) => byRole.get(role) ?? {}, close };
}
