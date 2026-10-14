import { existsSync } from "node:fs";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelRef } from "@earendil-works/pi-durable";
import frontdesk, { ContactsDoc, type Messenger } from "@officehum/frontdesk";
import {
  type CalendarClient,
  createGoogleCalendar,
  type GoogleCalendarOptions,
} from "@officehum/google-calendar";
import {
  type ConnectorIdentity,
  createDemoModels,
  createGoogleCalendarHost,
  type DecisionStore,
  type GoogleConnectorIdentity,
  hasDurableLocalState,
  hasDurableMessagingState,
  type LocalCalendar,
  type MessengerIdentity,
  messengerIdentityString,
  openConsoleMessenger,
  openLocalCalendar,
  openResendMessenger,
  openSolo,
  PI_DURABLE_VERSION,
  parseMessengerIdentity,
  type ResendMessenger,
  type ResendMessengerOptions,
  readConnectorIdentity,
  readMessengerIdentity,
  readSoloDocument,
  type SoloResult,
  type SoloSession,
} from "@officehum/office";
import type { ApprovalDecision, ApprovalRequest, Approver, HookContext } from "@officehum/sdk";

export interface CliIo {
  output(line: string): void;
  error(line: string): void;
  readApproval(prompt: string): Promise<string | undefined>;
}

class UsageError extends Error {}

let activeSession: SoloSession | undefined;

/** Called by the executable's SIGINT handler so unfinished durable work remains resumable. */
export async function interruptCli(): Promise<void> {
  await activeSession?.close();
}

type ApprovalMode = "allow" | "deny" | undefined;
type Parsed = {
  command: string;
  state: string;
  approval: ApprovalMode;
  message?: string;
  requestId?: string;
  model: string;
  calendar?: "local" | "google";
  messenger?: "console" | "resend";
};

export interface CliDependencies {
  readonly createGoogleCalendar?: (options: GoogleCalendarOptions) => CalendarClient;
  readonly createLiveModels?: (modelId: string) => {
    readonly models: ReturnType<typeof createModels>;
    readonly model: ModelRef;
  };
  readonly openResendMessenger?: (path: string, options: ResendMessengerOptions) => ResendMessenger;
}

const USAGE = `Usage:
  officehum demo [--state DIR] [--approval allow|deny] [--calendar local] [--messenger console]
  officehum start --message TEXT --request-id ID [--state DIR] [--model ID] [--approval allow|deny] [--calendar local|google] [--messenger console|resend]
  officehum resume [--state DIR] [--approval allow|deny] [--calendar local|google] [--messenger console|resend]
  officehum bookings [--state DIR] [--calendar local|google]
  officehum contacts [--state DIR]
  officehum --version`;

function parse(args: string[]): Parsed {
  const [command, ...rest] = args;
  if (command === undefined) throw new UsageError(USAGE);
  const parsed: Parsed = {
    command,
    state: ".officehum/frontdesk",
    approval: undefined,
    model: "gpt-6-sol",
  };
  const allowed = new Set(
    command === "start"
      ? [
          "--state",
          "--approval",
          "--message",
          "--request-id",
          "--model",
          "--calendar",
          "--messenger",
        ]
      : command === "demo" || command === "resume"
        ? ["--state", "--approval", "--calendar", "--messenger"]
        : command === "bookings"
          ? ["--state", "--calendar"]
          : command === "contacts"
            ? ["--state"]
            : [],
  );
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    if (option === undefined || !allowed.has(option)) {
      throw new UsageError(`Unknown option: ${option ?? ""}\n${USAGE}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${option} requires a value.\n${USAGE}`);
    }
    if (option === "--state") parsed.state = value;
    else if (option === "--message") parsed.message = value;
    else if (option === "--request-id") parsed.requestId = value;
    else if (option === "--model") parsed.model = value;
    else if (option === "--messenger") {
      if (value !== "console" && value !== "resend") {
        throw new UsageError("--messenger must be console or resend.");
      }
      parsed.messenger = value;
    } else if (option === "--calendar") {
      if (value !== "local" && value !== "google") {
        throw new UsageError("--calendar must be local or google.");
      }
      parsed.calendar = value;
    } else if (option === "--approval") {
      if (value !== "allow" && value !== "deny") {
        throw new UsageError("--approval must be allow or deny.");
      }
      parsed.approval = value;
    }
  }
  if (command === "start") {
    if (parsed.message === undefined) throw new UsageError("start requires --message.");
    if (parsed.requestId === undefined) throw new UsageError("start requires --request-id.");
  }
  if (command === "demo" && parsed.calendar === "google") {
    throw new UsageError("The synthetic demo uses only the local calendar.");
  }
  if (command === "demo" && parsed.messenger === "resend") {
    throw new UsageError("The synthetic demo uses only the console Messenger.");
  }
  return parsed;
}

function approvalKey(request: ApprovalRequest): string {
  return `${request.conversationId}:${request.taskId}:${request.callId}:${request.approvalId}`;
}

export function cliApprover(
  calendar: DecisionStore,
  mode: ApprovalMode,
  io: CliIo,
  interrupt: () => void,
): Approver {
  return async (request: ApprovalRequest, context: HookContext): Promise<ApprovalDecision> => {
    const key = approvalKey(request);
    const prior = calendar.decision(key);
    if (prior !== undefined) return prior;
    let answer = mode;
    if (answer === undefined) {
      io.output(
        `Approval required: ${request.description}\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.arguments)}`,
      );
      const read = await io.readApproval("Type allow or deny: ");
      if (read === undefined) {
        interrupt();
        await awaitWithContext(new Promise<never>(() => {}), context);
        throw new Error("approval input ended");
      }
      if (read !== "allow" && read !== "deny") {
        throw new Error('Approval must be exactly "allow" or "deny".');
      }
      answer = read;
    }
    return calendar.recordDecision(key, request, {
      approved: answer === "allow",
      by: mode === undefined ? "local-operator" : "cli-option",
      ...(answer === "deny" ? { note: "Declined by the local operator" } : {}),
    });
  };
}

type HostCalendar = DecisionStore & {
  freeSlots(date: string): Promise<string[]>;
  listBookings(): Promise<{ id: string; start: string; customer: string }[]>;
  book(
    start: string,
    customer: string,
    idempotencyKey: string,
  ): Promise<{ id: string; start: string; customer: string }>;
  reschedule(
    id: string,
    start: string,
    idempotencyKey: string,
  ): Promise<{ id: string; start: string; customer: string }>;
  cancel(
    id: string,
    idempotencyKey: string,
  ): Promise<{ id: string; status: "canceled"; alreadyCanceled: boolean }>;
  bookings():
    | ReturnType<LocalCalendar["bookings"]>
    | Promise<ReturnType<LocalCalendar["bookings"]>>;
};

const googleIdentity = (calendarId: string): GoogleConnectorIdentity => ({
  version: 1,
  backend: "google",
  calendarId,
  timeZone: "UTC",
  workingHours: { start: "09:00", end: "12:00" },
  durationMinutes: 60,
});

function selectedIdentity(parsed: Parsed): ConnectorIdentity {
  const stored = readConnectorIdentity(parsed.state);
  const hasStoredIdentity = existsSync(join(parsed.state, "connector.json"));
  const hasLegacyState = !hasStoredIdentity && hasDurableLocalState(parsed.state);
  const backend =
    parsed.calendar ?? (hasStoredIdentity || hasLegacyState ? stored.backend : "local");
  if ((hasStoredIdentity || hasLegacyState) && backend !== stored.backend) {
    throw new Error(
      `Front Desk connector identity mismatch: state uses ${stored.backend}, requested ${backend}.`,
    );
  }
  if (backend === "local") return { version: 1, backend: "local" };
  const configured = process.env.GOOGLE_CALENDAR_ID?.trim();
  if (stored.backend === "google") {
    if (configured !== undefined && configured.length > 0 && configured !== stored.calendarId) {
      throw new Error("Google calendar ID mismatch with the persisted connector identity.");
    }
    return stored;
  }
  if (configured === undefined || configured.length === 0) {
    throw new Error(
      "Set GOOGLE_CALENDAR_ID to an explicit calendar ID for initial Google binding.",
    );
  }
  if (configured === "primary") {
    throw new Error('GOOGLE_CALENDAR_ID must be explicit; "primary" is not allowed.');
  }
  return googleIdentity(configured);
}

function selectedMessengerIdentity(parsed: Parsed): MessengerIdentity {
  const stored = readMessengerIdentity(parsed.state);
  const legacy = stored === undefined && hasDurableMessagingState(parsed.state);
  const backend = parsed.messenger ?? stored?.backend ?? "console";
  if (legacy && backend !== "console") {
    throw new Error("Legacy Front Desk state is bound to the console Messenger.");
  }
  if (stored !== undefined && backend !== stored.backend) {
    throw new Error(
      `Front Desk Messenger identity mismatch: state uses ${stored.backend}, requested ${backend}.`,
    );
  }
  if (backend === "console") return { version: 1, backend: "console" };

  const configured = {
    accountId: process.env.RESEND_ACCOUNT_ID,
    fromEmail: process.env.RESEND_FROM_EMAIL,
    subject: process.env.RESEND_SUBJECT,
  };
  if (stored?.backend === "resend") {
    if (configured.accountId !== undefined && configured.accountId !== stored.accountId) {
      throw new Error("RESEND_ACCOUNT_ID does not match the persisted Messenger identity.");
    }
    if (configured.fromEmail !== undefined && configured.fromEmail !== stored.fromEmail) {
      throw new Error("RESEND_FROM_EMAIL does not match the persisted Messenger identity.");
    }
    if (configured.subject !== undefined && configured.subject !== stored.subject) {
      throw new Error("RESEND_SUBJECT does not match the persisted Messenger identity.");
    }
    return stored;
  }
  if (configured.accountId === undefined || configured.accountId.length === 0) {
    throw new Error("Set RESEND_ACCOUNT_ID for initial Resend binding.");
  }
  if (configured.fromEmail === undefined || configured.fromEmail.length === 0) {
    throw new Error("Set RESEND_FROM_EMAIL for initial Resend binding.");
  }
  if (configured.subject === undefined || configured.subject.length === 0) {
    throw new Error("Set RESEND_SUBJECT for initial Resend binding.");
  }
  return parseMessengerIdentity({
    version: 1,
    backend: "resend",
    accountId: configured.accountId,
    fromEmail: configured.fromEmail,
    subject: configured.subject,
  });
}

function requireResendApiKey(): string {
  const key = process.env.RESEND_API_KEY;
  if (key === undefined || key.trim().length === 0) {
    throw new Error("Set RESEND_API_KEY in your shell before Resend use.");
  }
  return key;
}

type HostedMessenger = Messenger & { close(): void | Promise<void> };

function createRoleFactory(
  parsed: Parsed,
  calendar: HostCalendar,
  approve: Approver,
  identity: MessengerIdentity,
  dependencies: CliDependencies,
) {
  return async () => {
    let messenger: HostedMessenger | undefined;
    try {
      messenger =
        identity.backend === "console"
          ? openConsoleMessenger(join(parsed.state, "messages.sqlite"))
          : (dependencies.openResendMessenger ?? openResendMessenger)(
              join(parsed.state, "email.sqlite"),
              {
                accountId: identity.accountId,
                fromEmail: identity.fromEmail,
                subject: identity.subject,
                getApiKey: async () => requireResendApiKey(),
              },
            );
      return {
        role: frontdesk({ calendar, approve, messenger }),
        close: () => messenger?.close(),
      };
    } catch (error) {
      await messenger?.close();
      throw error;
    }
  };
}

function printMessenger(identity: MessengerIdentity, messengerId: string, io: CliIo): void {
  if (identity.backend === "console") {
    io.output("Messaging: console outbox; no customer delivery.");
    io.output(`Messenger identity: ${messengerId}`);
    return;
  }
  io.output(
    `Messaging: Resend transport acceptance (not confirmed delivery). Account: ${identity.accountId}. From: ${identity.fromEmail}. Subject: ${identity.subject}. Identity: ${messengerId}`,
  );
}

function requireGoogleToken(): void {
  if (!process.env.GOOGLE_CALENDAR_ACCESS_TOKEN?.trim()) {
    throw new Error("Set GOOGLE_CALENDAR_ACCESS_TOKEN in your shell before Google Calendar use.");
  }
}

function openCalendar(
  parsed: Parsed,
  dependencies: CliDependencies,
): { calendar: HostCalendar; identity: ConnectorIdentity } {
  const identity = selectedIdentity(parsed);
  const decisions = openLocalCalendar(join(parsed.state, "calendar.sqlite"));
  if (identity.backend === "local") return { calendar: decisions, identity };
  try {
    requireGoogleToken();
    const factory = dependencies.createGoogleCalendar ?? createGoogleCalendar;
    const client = factory({
      calendarId: identity.calendarId,
      getAccessToken: async () => {
        const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN?.trim();
        if (!token) throw new Error("Google Calendar access token is unavailable.");
        return token;
      },
      timeZone: identity.timeZone,
      workingHours: identity.workingHours,
      durationMinutes: identity.durationMinutes,
    });
    return {
      calendar: createGoogleCalendarHost({
        client,
        decisions,
        durationMinutes: identity.durationMinutes,
      }),
      identity,
    };
  } catch (error) {
    decisions.close();
    throw error;
  }
}

function liveModels(modelId: string, dependencies: CliDependencies) {
  const injected = dependencies.createLiveModels?.(modelId);
  if (injected !== undefined) return injected;
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Set OPENAI_API_KEY in your shell before live start/resume.");
  }
  const models = createModels();
  models.setProvider(openaiProvider());
  const model = models.getModel("openai", modelId);
  if (model === undefined) throw new Error(`Unknown OpenAI model: ${modelId}`);
  return { models, model: { provider: "openai", modelId } };
}

function printResult(result: SoloResult, io: CliIo): number {
  io.output(`Submission: ${result.submissionId}`);
  io.output(`Outcome: ${result.settlement.status}`);
  if (result.text !== undefined && result.text.length > 0) io.output(result.text);
  if (result.settlement.status === "unanswered") {
    io.error(`Unanswered: ${result.settlement.reason}`);
    return 1;
  }
  return 0;
}

function modelLabel(model: ModelRef): string {
  if (model.provider === "officehum-demo") return `synthetic demo (${model.modelId})`;
  if (model.provider === "openai") return `live OpenAI (${model.modelId})`;
  return `${model.provider}/${model.modelId}`;
}

async function openForRun(
  parsed: Parsed,
  io: CliIo,
  demo: boolean,
  dependencies: CliDependencies,
): Promise<{
  calendar: HostCalendar;
  solo: SoloSession;
  model: ModelRef;
  messengerIdentity: MessengerIdentity;
  messengerId: string;
}> {
  const messengerIdentity = selectedMessengerIdentity(parsed);
  if (demo && messengerIdentity.backend !== "console") {
    throw new Error("The synthetic demo uses only the console Messenger.");
  }
  if (messengerIdentity.backend === "resend") requireResendApiKey();
  const { calendar, identity } = openCalendar(parsed, dependencies);
  let solo: SoloSession | undefined;
  let closeRequested = false;
  const interrupt = () => {
    closeRequested = true;
    void solo?.close();
  };
  try {
    const approve = cliApprover(
      calendar,
      demo && parsed.approval === undefined ? "allow" : parsed.approval,
      io,
      interrupt,
    );
    const runtime = demo ? createDemoModels() : liveModels(parsed.model, dependencies);
    solo = await openSolo({
      directory: parsed.state,
      createRole: createRoleFactory(parsed, calendar, approve, messengerIdentity, dependencies),
      messengerIdentity,
      ...runtime,
      connectorIdentity: identity,
    });
    activeSession = solo;
    const actualModel = (await solo.root.agent(BACKGROUND_CONTEXT)).model;
    if (actualModel === undefined) throw new Error("The persisted Front Desk root has no model.");
    const requestedProvider = demo ? "officehum-demo" : "openai";
    if (actualModel.provider !== requestedProvider) {
      const requested = demo ? "the synthetic demo" : "live OpenAI";
      throw new Error(
        `State ${parsed.state} already uses ${modelLabel(actualModel)}; use a fresh --state directory for ${requested}.`,
      );
    }
    if (closeRequested) await solo.close();
    return {
      calendar,
      solo,
      model: actualModel,
      messengerIdentity,
      messengerId: messengerIdentityString(messengerIdentity),
    };
  } catch (error) {
    try {
      await solo?.close();
    } finally {
      if (activeSession === solo) activeSession = undefined;
      calendar.close();
    }
    throw error;
  }
}

async function runResume(
  parsed: Parsed,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const messengerIdentity = selectedMessengerIdentity(parsed);
  if (messengerIdentity.backend === "resend") requireResendApiKey();
  const { calendar, identity } = openCalendar(parsed, dependencies);
  let probe: SoloSession | undefined;
  try {
    let active: SoloSession | undefined;
    let closeRequested = false;
    const interrupt = () => {
      closeRequested = true;
      void active?.close();
    };
    const approve = cliApprover(calendar, parsed.approval, io, interrupt);
    const demo = createDemoModels();
    probe = await openSolo({
      directory: parsed.state,
      createRole: createRoleFactory(parsed, calendar, approve, messengerIdentity, dependencies),
      messengerIdentity,
      ...demo,
      connectorIdentity: identity,
    });
    activeSession = probe;
    const agent = await probe.root.agent(BACKGROUND_CONTEXT);
    if (agent.model?.provider === "officehum-demo") {
      active = probe;
      probe = undefined;
      io.output(`Mode: ${modelLabel(agent.model)}`);
    } else {
      await probe.close();
      probe = undefined;
      const runtime = liveModels(agent.model?.modelId ?? parsed.model, dependencies);
      active = await openSolo({
        directory: parsed.state,
        createRole: createRoleFactory(parsed, calendar, approve, messengerIdentity, dependencies),
        messengerIdentity,
        ...runtime,
        connectorIdentity: identity,
      });
      activeSession = active;
      io.output(`Mode: ${modelLabel(runtime.model)}`);
    }
    if (closeRequested) await active.close();
    printMessenger(messengerIdentity, messengerIdentityString(messengerIdentity), io);
    try {
      const results = await active.resume();
      if (results.length === 0) {
        io.output("No pending work.");
        return 0;
      }
      return results.reduce((code, result) => Math.max(code, printResult(result, io)), 0);
    } finally {
      await active.close();
      if (activeSession === active) activeSession = undefined;
    }
  } finally {
    try {
      await probe?.close();
    } finally {
      if (activeSession === probe) activeSession = undefined;
      calendar.close();
    }
  }
}

export async function runCli(
  args: string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      io.output(`officehum 0.0.0 (Pi Durable ${PI_DURABLE_VERSION})`);
      return 0;
    }
    const parsed = parse(args);
    if (!new Set(["demo", "start", "resume", "bookings", "contacts"]).has(parsed.command)) {
      throw new UsageError(`Unknown command: ${parsed.command}\n${USAGE}`);
    }
    if (parsed.command === "contacts") {
      const state = await readSoloDocument(parsed.state, ContactsDoc);
      const contacts = [...(state?.contacts ?? [])].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
      if (contacts.length === 0) io.output("No contacts.");
      else {
        for (const { id, revision, name, email, phone } of contacts) {
          io.output(JSON.stringify({ id, revision, name, email, phone }));
        }
      }
      return 0;
    }
    if (parsed.command === "bookings") {
      const { calendar } = openCalendar(parsed, dependencies);
      try {
        const bookings = await calendar.bookings();
        if (bookings.length === 0) io.output("No bookings.");
        else for (const booking of bookings) io.output(JSON.stringify(booking));
      } finally {
        calendar.close();
      }
      return 0;
    }
    if (parsed.command === "resume") return await runResume(parsed, io, dependencies);

    const demo = parsed.command === "demo";
    const opened = await openForRun(parsed, io, demo, dependencies);
    try {
      io.output(`Mode: ${modelLabel(opened.model)}`);
      printMessenger(opened.messengerIdentity, opened.messengerId, io);
      if (demo && parsed.approval === undefined) {
        io.output("Synthetic demo approval: allow (default)");
      }
      const result = await opened.solo.submit(
        demo ? "Book Demo Guest on 2030-01-15" : (parsed.message ?? ""),
        demo ? "frontdesk-demo-2030-01-15" : (parsed.requestId ?? ""),
      );
      return printResult(result, io);
    } finally {
      try {
        await opened.solo.close();
      } finally {
        if (activeSession === opened.solo) activeSession = undefined;
        opened.calendar.close();
      }
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}
