import { existsSync } from "node:fs";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelRef } from "@earendil-works/pi-durable";
import frontdesk from "@officehum/frontdesk";
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
  type LocalCalendar,
  openLocalCalendar,
  openSolo,
  PI_DURABLE_VERSION,
  readConnectorIdentity,
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
};

export interface CliDependencies {
  readonly createGoogleCalendar?: (options: GoogleCalendarOptions) => CalendarClient;
  readonly createLiveModels?: (modelId: string) => {
    readonly models: ReturnType<typeof createModels>;
    readonly model: ModelRef;
  };
}

const USAGE = `Usage:
  officehum demo [--state DIR] [--approval allow|deny] [--calendar local]
  officehum start --message TEXT --request-id ID [--state DIR] [--model ID] [--approval allow|deny] [--calendar local|google]
  officehum resume [--state DIR] [--approval allow|deny] [--calendar local|google]
  officehum bookings [--state DIR] [--calendar local|google]
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
      ? ["--state", "--approval", "--message", "--request-id", "--model", "--calendar"]
      : command === "demo" || command === "resume"
        ? ["--state", "--approval", "--calendar"]
        : command === "bookings"
          ? ["--state", "--calendar"]
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
    else if (option === "--calendar") {
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
): Promise<{ calendar: HostCalendar; solo: SoloSession; model: ModelRef }> {
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
    const role = frontdesk({ calendar, approve });
    const runtime = demo ? createDemoModels() : liveModels(parsed.model, dependencies);
    solo = await openSolo({
      directory: parsed.state,
      role,
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
    return { calendar, solo, model: actualModel };
  } catch (error) {
    await solo?.close();
    if (activeSession === solo) activeSession = undefined;
    calendar.close();
    throw error;
  }
}

async function runResume(
  parsed: Parsed,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
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
    const role = frontdesk({ calendar, approve });
    const demo = createDemoModels();
    probe = await openSolo({
      directory: parsed.state,
      role,
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
        role,
        ...runtime,
        connectorIdentity: identity,
      });
      activeSession = active;
      io.output(`Mode: ${modelLabel(runtime.model)}`);
    }
    if (closeRequested) await active.close();
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
    await probe?.close();
    if (activeSession === probe) activeSession = undefined;
    calendar.close();
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
    if (!new Set(["demo", "start", "resume", "bookings"]).has(parsed.command)) {
      throw new UsageError(`Unknown command: ${parsed.command}\n${USAGE}`);
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
      if (demo && parsed.approval === undefined) {
        io.output("Synthetic demo approval: allow (default)");
      }
      const result = await opened.solo.submit(
        demo ? "Book Demo Guest on 2030-01-15" : (parsed.message ?? ""),
        demo ? "frontdesk-demo-2030-01-15" : (parsed.requestId ?? ""),
      );
      return printResult(result, io);
    } finally {
      await opened.solo.close();
      if (activeSession === opened.solo) activeSession = undefined;
      opened.calendar.close();
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}
