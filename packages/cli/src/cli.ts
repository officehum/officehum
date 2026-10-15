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
  createResendReplyMessenger,
  type DecisionStore,
  durableInboundReplyApprover,
  type GoogleConnectorIdentity,
  hasDurableLocalState,
  hasDurableMessagingState,
  type InboundSession,
  type InternalResendInbox,
  inboundAwareApprover,
  type LocalCalendar,
  type MessengerIdentity,
  messengerIdentityString,
  openConsoleMessenger,
  openInboundSession,
  openLocalCalendar,
  openResendInbox,
  openResendListener,
  openResendMessenger,
  openSolo,
  PI_DURABLE_VERSION,
  parseMessengerIdentity,
  type ResendListener,
  type ResendMessenger,
  type ResendMessengerOptions,
  type ResendReplyMessenger,
  readConnectorIdentity,
  readInboundAuthority,
  readInboundInbox,
  readMessengerIdentity,
  readSoloDocument,
  type SoloResult,
  type SoloSession,
} from "@officehum/office";
import type { ApprovalDecision, ApprovalRequest, Approver, HookContext } from "@officehum/sdk";
import { PAPER_MODEL_REF, paperProvider } from "./paper-provider.js";

export interface CliIo {
  output(line: string): void;
  error(line: string): void;
  readApproval(prompt: string): Promise<string | undefined>;
}

class UsageError extends Error {}

let activeSession: { close(): Promise<void> } | undefined;

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
  provider: "paper" | "openai";
  modelProvided: boolean;
  calendar?: "local" | "google";
  messenger?: "console" | "resend";
  port: number;
};

export interface CliDependencies {
  readonly createGoogleCalendar?: (options: GoogleCalendarOptions) => CalendarClient;
  readonly createLiveModels?: (ref: ModelRef) => {
    readonly models: ReturnType<typeof createModels>;
    readonly model: ModelRef;
  };
  readonly openResendMessenger?: (path: string, options: ResendMessengerOptions) => ResendMessenger;
}

const USAGE = `Usage:
  officehum demo [--state DIR] [--approval allow|deny] [--calendar local] [--messenger console]
  officehum start --message TEXT --request-id ID [--state DIR] [--provider paper|openai] [--model ID] [--approval allow|deny] [--calendar local|google] [--messenger console|resend]
  officehum resume [--state DIR] [--approval allow|deny] [--calendar local|google] [--messenger console|resend]
  officehum listen [--state DIR] [--provider paper|openai] [--model ID] [--approval allow|deny] [--calendar local|google] --messenger resend [--port PORT]
  officehum inbox [--state DIR]
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
    model: "",
    modelProvided: false,
    provider: "paper",
    port: 8787,
  };
  const allowed = new Set(
    command === "start"
      ? [
          "--state",
          "--approval",
          "--message",
          "--request-id",
          "--model",
          "--provider",
          "--calendar",
          "--messenger",
        ]
      : command === "demo" || command === "resume"
        ? ["--state", "--approval", "--calendar", "--messenger"]
        : command === "listen"
          ? [
              "--state",
              "--approval",
              "--model",
              "--provider",
              "--calendar",
              "--messenger",
              "--port",
            ]
          : command === "bookings"
            ? ["--state", "--calendar"]
            : command === "contacts" || command === "inbox"
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
    else if (option === "--model") {
      parsed.model = value;
      parsed.modelProvided = true;
    } else if (option === "--provider") {
      if (value !== "paper" && value !== "openai") {
        throw new UsageError("--provider must be paper or openai.");
      }
      parsed.provider = value;
    } else if (option === "--port") {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new UsageError("--port must be an integer from 1 through 65535.");
      }
      parsed.port = port;
    } else if (option === "--messenger") {
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
  if (command === "start" || command === "listen") {
    if (!parsed.modelProvided) {
      parsed.model = parsed.provider === "paper" ? PAPER_MODEL_REF.modelId : "gpt-6-sol";
    }
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
      const read = await queuedApprovalRead(request, io, context);
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

const terminalApprovalQueues = new WeakMap<CliIo, Promise<void>>();

async function queuedApprovalRead(
  request: ApprovalRequest,
  io: CliIo,
  context: HookContext,
): Promise<string | undefined> {
  const prior = terminalApprovalQueues.get(io) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  terminalApprovalQueues.set(
    io,
    prior.then(() => held),
  );
  try {
    await awaitWithContext(prior, context);
    io.output(
      `Approval required: ${request.description}\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.arguments)}`,
    );
    return await awaitWithContext(io.readApproval("Type allow or deny: "), context);
  } finally {
    release();
  }
}

export function cliReplyDecision(mode: ApprovalMode, io: CliIo, interrupt: () => void): Approver {
  return async (request, context) => {
    let answer = mode;
    if (answer === undefined) {
      const read = await queuedApprovalRead(request, io, context);
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
    return {
      approved: answer === "allow",
      by: mode === undefined ? "local-operator" : "cli-option",
      ...(answer === "deny" ? { note: "Declined by the local operator" } : {}),
    };
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

function requireInboundEmail(): string {
  const value = process.env.RESEND_INBOUND_EMAIL;
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Set RESEND_INBOUND_EMAIL before inbound email use.");
  }
  return value;
}

function webhookSecrets(): readonly string[] {
  const current = process.env.RESEND_WEBHOOK_SECRET;
  if (current === undefined || current.trim().length === 0) {
    throw new Error("Set RESEND_WEBHOOK_SECRET before listening for inbound email.");
  }
  const previous = process.env.RESEND_WEBHOOK_SECRET_PREVIOUS;
  const values =
    previous === undefined || previous.trim().length === 0 ? [current] : [current, previous];
  for (const value of values) {
    if (!value.startsWith("whsec_") || value.length > 1000) {
      throw new Error("RESEND_WEBHOOK_SECRET is invalid.");
    }
    const encoded = value.slice(6);
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) ||
      Buffer.from(encoded, "base64").toString("base64") !== encoded
    ) {
      throw new Error("RESEND_WEBHOOK_SECRET is invalid.");
    }
  }
  return values;
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

function liveModels(ref: ModelRef, dependencies: CliDependencies) {
  if (ref.provider !== "paper" && ref.provider !== "openai") {
    throw new Error(`Unsupported live provider: ${ref.provider}`);
  }
  if (
    !ref.modelId.trim() ||
    (ref.provider === "paper" && ref.modelId !== PAPER_MODEL_REF.modelId)
  ) {
    throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
  }
  const injected = dependencies.createLiveModels?.(ref);
  if (injected !== undefined) {
    if (injected.model.provider !== ref.provider || injected.model.modelId !== ref.modelId) {
      throw new Error("Injected live model does not match the requested provider/model.");
    }
    if (injected.models.getModel(ref.provider, ref.modelId) === undefined) {
      throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
    }
    return injected;
  }
  const keyName = ref.provider === "paper" ? "PAPERINSTRUMENTS_API_KEY" : "OPENAI_API_KEY";
  if (!process.env[keyName]?.trim()) throw new Error(`Set ${keyName} before live start/resume.`);
  const models = createModels();
  models.setProvider(ref.provider === "paper" ? paperProvider() : openaiProvider());
  if (models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new Error(`Unknown ${ref.provider} model: ${ref.modelId}`);
  }
  return { models, model: ref };
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

function printInboundResult(result: SoloResult, io: CliIo): number {
  io.output(`Submission: ${result.submissionId}`);
  io.output(`Outcome: ${result.settlement.status}`);
  if (result.settlement.status === "unanswered") {
    io.error("Inbound submission was unanswered.");
    return 1;
  }
  return 0;
}

function modelLabel(model: ModelRef): string {
  if (model.provider === "officehum-demo") return `synthetic demo (${model.modelId})`;
  if (model.provider === "openai") return `live OpenAI (${model.modelId})`;
  if (model.provider === "paper") return `live Paper (${model.modelId})`;
  return `${model.provider}/${model.modelId}`;
}

async function closeEvery(actions: readonly (() => void | Promise<void>)[]): Promise<boolean> {
  let failed = false;
  for (const action of actions) {
    try {
      await action();
    } catch {
      failed = true;
    }
  }
  return failed;
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
    const selectedRuntime = demo
      ? createDemoModels()
      : liveModels({ provider: parsed.provider, modelId: parsed.model }, dependencies);
    const runtime =
      !demo && parsed.provider === "paper"
        ? { ...selectedRuntime, model: { ...selectedRuntime.model, thinkingLevel: "max" as const } }
        : selectedRuntime;
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
    const requestedProvider = demo ? "officehum-demo" : parsed.provider;
    const requestedModelId = demo ? actualModel.modelId : parsed.model;
    if (actualModel.provider !== requestedProvider || actualModel.modelId !== requestedModelId) {
      if (demo || actualModel.provider === "officehum-demo") {
        const requested = demo ? "the synthetic demo" : `live ${parsed.provider}`;
        throw new Error(
          `State ${parsed.state} already uses ${modelLabel(actualModel)}; use a fresh --state directory for ${requested}.`,
        );
      }
      throw new Error(
        `State ${parsed.state} already uses ${modelLabel(actualModel)}; requested ${requestedProvider}/${requestedModelId}.`,
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

type InboundHosted = {
  inbox: InternalResendInbox;
  reply: ResendReplyMessenger;
  role: ReturnType<typeof frontdesk>;
};

function customerTools(role: ReturnType<typeof frontdesk>) {
  const offered = role.extensions
    .flatMap((extension) => extension.tools ?? [])
    .filter(({ name }) => name === "check_schedule" || name === "reply_message");
  const selection = role.agent.tools;
  if (selection === undefined || selection === null) return offered;
  if ("remove" in selection) {
    const removed = new Set(selection.remove.map(({ name }) => name));
    return offered.filter(({ name }) => !removed.has(name));
  }
  const selected = new Set(selection.map(({ name }) => name));
  return offered.filter(({ name }) => selected.has(name));
}

async function openInboundRuntime(
  parsed: Parsed,
  calendar: HostCalendar,
  connectorIdentity: ConnectorIdentity,
  messengerIdentity: Extract<MessengerIdentity, { backend: "resend" }>,
  runtime: { models: ReturnType<typeof createModels>; model: ModelRef },
  rootDecision: Approver,
  replyDecision: Approver,
  dependencies: CliDependencies,
): Promise<{
  solo: SoloSession;
  hosted: InboundHosted;
  model: ModelRef;
  attach(): void;
}> {
  let attachedHarness: SoloSession["harness"] | undefined;
  let hosted: InboundHosted | undefined;
  const savedAuthority = readInboundAuthority(parsed.state);
  const solo = await openSolo({
    directory: parsed.state,
    models: runtime.models,
    model: runtime.model,
    messengerIdentity,
    connectorIdentity,
    createRole: async () => {
      let outbound: HostedMessenger | undefined;
      let inbox: InternalResendInbox | undefined;
      let reply: ResendReplyMessenger | undefined;
      try {
        outbound = (dependencies.openResendMessenger ?? openResendMessenger)(
          join(parsed.state, "email.sqlite"),
          {
            accountId: messengerIdentity.accountId,
            fromEmail: messengerIdentity.fromEmail,
            subject: messengerIdentity.subject,
            getApiKey: async () => requireResendApiKey(),
          },
        );
        inbox = openResendInbox(join(parsed.state, "inbound.sqlite"), {
          authority: savedAuthority,
          getApiKey: async () => requireResendApiKey(),
          getWebhookSecrets: async () => webhookSecrets(),
        });
        reply = createResendReplyMessenger({
          inbox,
          getHarness: () => attachedHarness,
          getApiKey: async () => requireResendApiKey(),
        });
        const role = frontdesk({
          calendar,
          messenger: outbound,
          approve: inboundAwareApprover(() => attachedHarness, rootDecision),
          replyMessenger: reply,
          approveReply: durableInboundReplyApprover(inbox, replyDecision),
        });
        hosted = { inbox, reply, role };
        return {
          role,
          close: async () => {
            if (
              await closeEvery([
                async () => reply?.close(),
                async () => inbox?.close(),
                async () => outbound?.close(),
              ])
            ) {
              throw new Error("Inbound hosted cleanup failed.");
            }
          },
        };
      } catch (error) {
        await closeEvery([
          async () => reply?.close(),
          async () => inbox?.close(),
          async () => outbound?.close(),
        ]);
        throw error;
      }
    },
  });
  if (hosted === undefined) {
    await solo.close();
    throw new Error("Inbound role resources were not created.");
  }
  return {
    solo,
    hosted,
    model: runtime.model,
    attach() {
      attachedHarness = solo.harness;
    },
  };
}

async function runListen(
  parsed: Parsed,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  parsed.messenger ??= "resend";
  const messengerIdentity = selectedMessengerIdentity(parsed);
  if (messengerIdentity.backend !== "resend") {
    throw new Error("Inbound listening requires the Resend Messenger.");
  }
  requireResendApiKey();
  const inboundEmail = requireInboundEmail();
  webhookSecrets();
  const { calendar, identity } = openCalendar(parsed, dependencies);
  let solo: SoloSession | undefined;
  let attachedHarness: SoloSession["harness"] | undefined;
  let hosted: InboundHosted | undefined;
  let listener: ResendListener | undefined;
  let session: InboundSession | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let stop!: () => void;
  const done = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let closeQueue = Promise.resolve();
  const close = async (): Promise<void> => {
    stopped = true;
    const current = closeQueue.then(async () => {
      if (timer !== undefined) clearInterval(timer);
      const failed = await closeEvery([
        async () => listener?.close(),
        async () => session?.close(),
        async () => solo?.close(),
      ]);
      stop();
      if (failed) throw new Error("Inbound shutdown failed.");
    });
    closeQueue = current.catch(() => {});
    return current;
  };
  const ensureRunning = async (): Promise<void> => {
    if (!stopped) return;
    await close();
    throw new Error("Inbound operation was interrupted.");
  };
  const interrupt = () => void close();
  const rootDecision = cliApprover(calendar, parsed.approval, io, interrupt);
  const replyDecision = cliReplyDecision(parsed.approval, io, interrupt);
  activeSession = { close };
  try {
    const selectedRuntime = liveModels(
      { provider: parsed.provider, modelId: parsed.model },
      dependencies,
    );
    const runtime =
      parsed.provider === "paper"
        ? { ...selectedRuntime, model: { ...selectedRuntime.model, thinkingLevel: "max" as const } }
        : selectedRuntime;
    await ensureRunning();
    solo = await openSolo({
      directory: parsed.state,
      models: runtime.models,
      model: runtime.model,
      messengerIdentity,
      connectorIdentity: identity,
      createRole: async () => {
        let outbound: HostedMessenger | undefined;
        let inbox: InternalResendInbox | undefined;
        let reply: ResendReplyMessenger | undefined;
        try {
          outbound = (dependencies.openResendMessenger ?? openResendMessenger)(
            join(parsed.state, "email.sqlite"),
            {
              accountId: messengerIdentity.accountId,
              fromEmail: messengerIdentity.fromEmail,
              subject: messengerIdentity.subject,
              getApiKey: async () => requireResendApiKey(),
            },
          );
          inbox = openResendInbox(join(parsed.state, "inbound.sqlite"), {
            authority: {
              version: 1,
              messengerId: messengerIdentityString(messengerIdentity),
              accountId: messengerIdentity.accountId,
              fromEmail: messengerIdentity.fromEmail,
              inboundEmail,
            },
            getApiKey: async () => requireResendApiKey(),
            getWebhookSecrets: async () => webhookSecrets(),
          });
          reply = createResendReplyMessenger({
            inbox,
            getHarness: () => attachedHarness,
            getApiKey: async () => requireResendApiKey(),
          });
          const role = frontdesk({
            calendar,
            messenger: outbound,
            approve: inboundAwareApprover(() => attachedHarness, rootDecision),
            replyMessenger: reply,
            approveReply: durableInboundReplyApprover(inbox, replyDecision),
          });
          hosted = { inbox, reply, role };
          return {
            role,
            close: async () => {
              if (
                await closeEvery([
                  async () => reply?.close(),
                  async () => inbox?.close(),
                  async () => outbound?.close(),
                ])
              ) {
                throw new Error("Inbound hosted cleanup failed.");
              }
            },
          };
        } catch (error) {
          await closeEvery([
            async () => reply?.close(),
            async () => inbox?.close(),
            async () => outbound?.close(),
          ]);
          throw error;
        }
      },
    });
    await ensureRunning();
    const savedModel = (await solo.root.agent(BACKGROUND_CONTEXT)).model;
    if (savedModel?.provider !== parsed.provider || savedModel.modelId !== parsed.model) {
      throw new Error(
        `State ${parsed.state} already uses ${savedModel === undefined ? "an unknown model" : modelLabel(savedModel)}; requested ${parsed.provider}/${parsed.model}.`,
      );
    }
    attachedHarness = solo.harness;
    if (hosted === undefined) throw new Error("Inbound role resources were not created.");
    session = openInboundSession({
      solo,
      inbox: hosted.inbox,
      customerAgent: {
        ...hosted.role.agent,
        model: runtime.model,
        tools: customerTools(hosted.role),
      },
    });
    await session.reconcile();
    await ensureRunning();
    await session.tick();
    await ensureRunning();
    listener = await openResendListener({ inbox: hosted.inbox, port: parsed.port });
    await ensureRunning();
    timer = setInterval(() => {
      void session?.tick().catch(() => io.error("Inbound worker tick failed."));
    }, 5000);
    io.output(`Inbound listener: ${listener.address}/webhooks/resend`);
    io.output(`Approval: ${parsed.approval ?? "interactive review"}`);
    await done;
    return 0;
  } finally {
    try {
      await close();
    } finally {
      if (activeSession?.close === close) activeSession = undefined;
      calendar.close();
    }
  }
}

async function runInboundResume(
  parsed: Parsed,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const selected = selectedMessengerIdentity(parsed);
  if (selected.backend !== "resend")
    throw new Error("Inbound resume requires the Resend Messenger.");
  requireResendApiKey();
  const { calendar, identity } = openCalendar(parsed, dependencies);
  let active: Awaited<ReturnType<typeof openInboundRuntime>> | undefined;
  let probe: Awaited<ReturnType<typeof openInboundRuntime>> | undefined;
  let session: InboundSession | undefined;
  let closeRequested = false;
  let closeQueue = Promise.resolve();
  const close = async (): Promise<void> => {
    closeRequested = true;
    const current = closeQueue.then(async () => {
      if (
        await closeEvery([
          async () => session?.close(),
          async () => active?.solo.close(),
          async () => probe?.solo.close(),
        ])
      ) {
        throw new Error("Inbound shutdown failed.");
      }
    });
    closeQueue = current.catch(() => {});
    return current;
  };
  const ensureRunning = async (): Promise<void> => {
    if (!closeRequested) return;
    await close();
    throw new Error("Inbound operation was interrupted.");
  };
  const interrupt = () => void close();
  const rootDecision = cliApprover(calendar, parsed.approval, io, interrupt);
  const replyDecision = cliReplyDecision(parsed.approval, io, interrupt);
  activeSession = { close };
  try {
    const demo = createDemoModels();
    probe = await openInboundRuntime(
      parsed,
      calendar,
      identity,
      selected,
      demo,
      rootDecision,
      replyDecision,
      dependencies,
    );
    await ensureRunning();
    const agent = await probe.solo.root.agent(BACKGROUND_CONTEXT);
    await ensureRunning();
    if (agent.model?.provider === "officehum-demo") {
      active = probe;
      probe = undefined;
      io.output(`Mode: ${modelLabel(agent.model)}`);
    } else {
      await probe.solo.close();
      probe = undefined;
      await ensureRunning();
      if (agent.model === undefined) throw new Error("The persisted Front Desk root has no model.");
      const runtime = liveModels(agent.model, dependencies);
      await ensureRunning();
      active = await openInboundRuntime(
        parsed,
        calendar,
        identity,
        selected,
        runtime,
        rootDecision,
        replyDecision,
        dependencies,
      );
      await ensureRunning();
      io.output(`Mode: ${modelLabel(runtime.model)}`);
    }
    active.attach();
    session = openInboundSession({
      solo: active.solo,
      inbox: active.hosted.inbox,
      customerAgent: {
        ...active.hosted.role.agent,
        model: active.model,
        ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
        tools: customerTools(active.hosted.role),
      },
    });
    await session.reconcile();
    await ensureRunning();
    await session.tick();
    await ensureRunning();
    printMessenger(selected, messengerIdentityString(selected), io);
    const results = await active.solo.resume();
    await ensureRunning();
    await active.solo.harness.waitForIdle(BACKGROUND_CONTEXT);
    await ensureRunning();
    await session.reconcile();
    await ensureRunning();
    if (results.length === 0) {
      io.output("No pending work.");
      return 0;
    }
    return results.reduce((code, result) => Math.max(code, printInboundResult(result, io)), 0);
  } finally {
    try {
      await close();
    } finally {
      if (activeSession?.close === close) activeSession = undefined;
      calendar.close();
    }
  }
}

async function runResume(
  parsed: Parsed,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  if (existsSync(join(parsed.state, "inbound.sqlite"))) {
    return runInboundResume(parsed, io, dependencies);
  }
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
      if (agent.model === undefined) throw new Error("The persisted Front Desk root has no model.");
      const runtime = liveModels(agent.model, dependencies);
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
    if (
      !new Set(["demo", "start", "resume", "listen", "inbox", "bookings", "contacts"]).has(
        parsed.command,
      )
    ) {
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
    if (parsed.command === "inbox") {
      if (!existsSync(join(parsed.state, "inbound.sqlite"))) {
        throw new Error("No inbound inbox exists for this state directory.");
      }
      const summaries = await readInboundInbox(parsed.state);
      if (summaries.length === 0) io.output("No inbound email receipts.");
      else for (const summary of summaries) io.output(JSON.stringify(summary));
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
    if (parsed.command === "listen") return await runListen(parsed, io, dependencies);

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
