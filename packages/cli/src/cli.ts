import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelRef } from "@earendil-works/pi-durable";
import frontdesk from "@officehum/frontdesk";
import {
  createDemoModels,
  type LocalCalendar,
  openLocalCalendar,
  openSolo,
  PI_DURABLE_VERSION,
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
};

const USAGE = `Usage:
  officehum demo [--state DIR] [--approval allow|deny]
  officehum start --message TEXT --request-id ID [--state DIR] [--model ID] [--approval allow|deny]
  officehum resume [--state DIR] [--approval allow|deny]
  officehum bookings [--state DIR]
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
      ? ["--state", "--approval", "--message", "--request-id", "--model"]
      : command === "demo" || command === "resume"
        ? ["--state", "--approval"]
        : command === "bookings"
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
    else if (option === "--approval") {
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
  return parsed;
}

function approvalKey(request: ApprovalRequest): string {
  return `${request.conversationId}:${request.taskId}:${request.callId}:${request.approvalId}`;
}

export function cliApprover(
  calendar: LocalCalendar,
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

function liveModels(modelId: string) {
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
): Promise<{ calendar: LocalCalendar; solo: SoloSession; model: ModelRef }> {
  const calendar = openLocalCalendar(join(parsed.state, "calendar.sqlite"));
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
    const runtime = demo ? createDemoModels() : liveModels(parsed.model);
    solo = await openSolo({ directory: parsed.state, role, ...runtime });
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

async function runResume(parsed: Parsed, io: CliIo): Promise<number> {
  const calendar = openLocalCalendar(join(parsed.state, "calendar.sqlite"));
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
    probe = await openSolo({ directory: parsed.state, role, ...demo });
    activeSession = probe;
    const agent = await probe.root.agent(BACKGROUND_CONTEXT);
    if (agent.model?.provider === "officehum-demo") {
      active = probe;
      probe = undefined;
      io.output(`Mode: ${modelLabel(agent.model)}`);
    } else {
      await probe.close();
      probe = undefined;
      const runtime = liveModels(agent.model?.modelId ?? parsed.model);
      active = await openSolo({ directory: parsed.state, role, ...runtime });
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

export async function runCli(args: string[], io: CliIo): Promise<number> {
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
      const calendar = openLocalCalendar(join(parsed.state, "calendar.sqlite"));
      try {
        const bookings = calendar.bookings();
        if (bookings.length === 0) io.output("No bookings.");
        else for (const booking of bookings) io.output(JSON.stringify(booking));
      } finally {
        calendar.close();
      }
      return 0;
    }
    if (parsed.command === "resume") return await runResume(parsed, io);

    const demo = parsed.command === "demo";
    const opened = await openForRun(parsed, io, demo);
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
