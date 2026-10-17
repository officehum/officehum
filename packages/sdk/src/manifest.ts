/**
 * `officehum.json`: the metadata Office Hum reads from a role package without running its code.
 * Pi Durable ignores this file. See docs/design/agent-package.md.
 */

import semver from "semver";
import { type Static, Type } from "typebox";
import { type Issue, joinPath, schemaIssues, show, type Validation } from "./issues.js";

/** The manifest file every role package ships next to its package.json. */
export const MANIFEST_FILE = "officehum.json";

/** The manifest format this SDK reads and writes. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Departments a role can belong to. The UI groups the team by department. */
export const DEPARTMENTS = [
  "front-office",
  "finance",
  "operations",
  "sales",
  "marketing",
  "people",
] as const;

/** Where a role may face the business's own customers. */
export const CHANNELS = ["email", "sms", "chat"] as const;

/** Pi Durable thinking levels a manifest may recommend. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Models a sub-agent may run on: the office's small model, or the role's default one. */
export const SUBAGENT_MODELS = ["small", "default"] as const;

/**
 * Subject kinds a role's memory may hold. A record's subject is one of these plus an id, e.g.
 * `customer:acme` or `vendor:42`; see "Memory" in docs/design/agent-package.md.
 */
export const MEMORY_SUBJECTS = [
  "business",
  "customer",
  "vendor",
  "person",
  "agent",
  "topic",
] as const;

/** Tokens a role's stable prompt may use when its context plan sets no `promptBudgetTokens`. */
export const DEFAULT_PROMPT_BUDGET_TOKENS = 4000;

/** Tools the SDK gives every role built with `defineRole`; a manifest does not declare them. */
export const SDK_TOOL_NAMES = ["read_skill"] as const;

/**
 * Tool names a role may not declare: the SDK's own, and those the Office provides through its
 * extension, which would otherwise collide with the role's when both are selected.
 */
export const RESERVED_TOOL_NAMES = [
  ...SDK_TOOL_NAMES,
  "board_create",
  "board_claim",
  "board_comment",
  "board_complete",
  "board_read",
  "delegate",
  "ask",
] as const;

const KebabId = Type.String({
  pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$",
  maxLength: 64,
  "x-hint": 'kebab-case, like "front-desk"',
});
const SnakeName = Type.String({
  pattern: "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
  maxLength: 64,
  "x-hint": 'snake_case, like "create_invoice"',
});
const TicketType = Type.String({
  pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
  maxLength: 64,
  "x-hint": 'a dotted ticket type, like "invoice.create"',
});
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const SNAKE_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Words passed to the role's engine, e.g. `["variance", "--summary"]`. */
const EngineArgs = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

/** One parameter of an engine tool; it reaches the engine as `--name value`. */
const ParameterDeclaration = Type.Object(
  {
    type: Type.Enum(["string", "number", "integer", "boolean"]),
    description: Text(300),
    required: Type.Optional(Type.Boolean()),
    enum: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]), { minItems: 1 })),
  },
  { additionalProperties: false },
);

const ToolDeclaration = Type.Object(
  {
    name: SnakeName,
    replay: Type.Enum(["safe", "unsafe"]),
    skill: Type.Optional(KebabId),
    /** What the model reads about the tool. Required for engine tools, which have no code. */
    description: Type.Optional(Text(1000)),
    /** Engine tools: the subcommand this tool runs. `defineRole` builds the tool from the manifest. */
    engine: Type.Optional(EngineArgs),
    parameters: Type.Optional(Type.Record(Type.String(), ParameterDeclaration)),
    /** Rules for using the tool, added to its description. */
    guidelines: Type.Optional(Type.Array(Text(300))),
    /**
     * Why this unsafe tool needs no approval, e.g. "internal note; no outside effect". An unsafe
     * tool states exactly one of the two: an approval in `approvals`, or this note. A safe tool
     * states neither.
     */
    noApproval: Type.Optional(Text(300)),
  },
  { additionalProperties: false },
);

/**
 * A number the business sets: the role declares the limit with a description and a default, and an
 * overlay changes the value. Limits live in `officehum.json` and overlays, never in prompt text.
 */
const LimitDeclaration = Type.Object(
  { description: Text(300), default: Type.Number() },
  { additionalProperties: false },
);

/**
 * A condition's value that names a limit, e.g. `{ "limit": "large_invoice" }`, instead of a number.
 * It resolves to the business's value for that limit when the approval gate runs.
 */
const LimitReference = Type.Object({ limit: SnakeName }, { additionalProperties: false });

/** A condition on a tool call's arguments, e.g. `{ "arg": "amount", "op": "gt", "value": 2500 }`. */
const ConditionDeclaration = Type.Object(
  {
    arg: Type.String({ minLength: 1 }),
    op: Type.Enum(["gt", "gte", "lt", "lte", "eq", "ne", "in"]),
    value: Type.Union([
      Type.Number(),
      Type.String(),
      Type.Boolean(),
      Type.Array(Type.Union([Type.Number(), Type.String()])),
      LimitReference,
    ]),
  },
  { additionalProperties: false },
);

const ApprovalDeclaration = Type.Object(
  {
    id: SnakeName,
    tool: SnakeName,
    description: Text(200),
    /** The approval applies only when every condition holds. Omitted: every call of the tool. */
    when: Type.Optional(Type.Array(ConditionDeclaration, { minItems: 1 })),
  },
  { additionalProperties: false },
);

/** A program the host must provide, e.g. `{ "name": "python3", "version": ">=3.10" }`. */
const RuntimeDeclaration = Type.Object(
  {
    name: Type.String({
      pattern: "^[a-z][a-z0-9._+-]*$",
      maxLength: 64,
      "x-hint": 'a program name, like "python3"',
    }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

/** The role's deterministic engine: a command run from the package root. */
const EngineDeclaration = Type.Object(
  { command: EngineArgs, description: Type.Optional(Text(300)) },
  { additionalProperties: false },
);

/** An operator view: runs the engine and shows the result, without the model. */
const CommandDeclaration = Type.Object(
  { name: KebabId, description: Text(200), engine: EngineArgs },
  { additionalProperties: false },
);

/** Values a completion-evidence entry passes; a string may interpolate the ticket, see `doneIssues`. */
const EvidenceArguments = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);

/**
 * One piece of completion evidence: something that must check out before a ticket is done. The host
 * runs it, never the model. Every entry of an `accepts[]` entry's `done` must pass.
 */
const CompletionEvidence = Type.Union(
  [
    /** The role's engine answers `ok` with at least one finding. */
    Type.Object(
      { engine: EngineArgs, args: Type.Optional(EvidenceArguments) },
      { additionalProperties: false },
    ),
    /** A declared safe tool, run by the host, whose result reports `details.found`. */
    Type.Object(
      { tool: SnakeName, args: Type.Optional(EvidenceArguments), expect: Type.Literal("found") },
      { additionalProperties: false },
    ),
    /** A file the ticket's result attaches under this name. */
    Type.Object({ file: Text(128) }, { additionalProperties: false }),
    /** A person confirms the work. */
    Type.Object({ person: Type.Literal(true) }, { additionalProperties: false }),
  ],
  {
    "x-hint":
      'must be one of: { "engine": ["subcommand", …], "args": { "flag": "{ticket.data.<path>}" } }, { "tool": "NAME", "args": {…}, "expect": "found" }, { "file": "NAME" }, or { "person": true }',
  },
);
export type DoneEvidence = Static<typeof CompletionEvidence>;

const AcceptDeclaration = Type.Object(
  {
    type: TicketType,
    description: Text(200),
    /** Every entry must pass before a ticket of this type is done. */
    done: Type.Optional(Type.Array(CompletionEvidence)),
  },
  { additionalProperties: false },
);

/** A bundled skill. Its name and description live in `skills/<id>/SKILL.md`, so they cannot drift. */
const SkillDeclaration = Type.Object(
  { id: KebabId, enabledByDefault: Type.Boolean() },
  { additionalProperties: false },
);

const ModelDeclaration = Type.Object(
  {
    provider: Text(64),
    modelId: Text(128),
    thinkingLevel: Type.Optional(Type.Enum([...THINKING_LEVELS])),
  },
  { additionalProperties: false },
);

/** A ticket type this role hands to another role, and when it does. */
const DispatchDeclaration = Type.Object(
  { type: TicketType, when: Text(300) },
  { additionalProperties: false },
);

/** Something the role never does, and what it does instead. Wisdom data, shown on its card. */
const MayNotDeclaration = Type.Object(
  { action: Text(200), instead: Text(300) },
  { additionalProperties: false },
);

/** A business document the role needs searchable, instead of pasting it into the prompt. */
const RetrievalSourceDeclaration = Type.Object(
  { id: KebabId, description: Text(300) },
  { additionalProperties: false },
);

/**
 * A narrow worker the role may run: safe tools only, a small or default model, and the JSON Schema
 * its result must match. See "Context engineering" in docs/design/agent-package.md.
 */
const SubagentDeclaration = Type.Object(
  {
    id: KebabId,
    purpose: Text(300),
    model: Type.Enum([...SUBAGENT_MODELS]),
    tools: Type.Array(SnakeName, { minItems: 1 }),
    skills: Type.Optional(Type.Array(KebabId, { minItems: 1 })),
    output: Type.Object({}, { additionalProperties: true }),
    maxParallel: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** What each request keeps from the transcript. */
const HistoryFilterDeclaration = Type.Object(
  {
    keepRecentRounds: Type.Integer({ minimum: 0 }),
    keepCitedIds: Type.Boolean(),
    maxToolResultTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** A set of tools offered only while the current ticket is one of `forTicketTypes`. */
const ToolGroupDeclaration = Type.Object(
  {
    id: KebabId,
    tools: Type.Array(SnakeName, { minItems: 1 }),
    forTicketTypes: Type.Array(TicketType, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** How the role decides what each request sees: the context-engineering techniques it uses. */
const ContextPlanDeclaration = Type.Object(
  {
    /** Tokens the role's stable prompt may use; default `DEFAULT_PROMPT_BUDGET_TOKENS`. */
    promptBudgetTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Business documents the role searches instead of pasting them in. */
    retrieval: Type.Optional(
      Type.Object(
        { sources: Type.Array(RetrievalSourceDeclaration, { minItems: 1 }) },
        { additionalProperties: false },
      ),
    ),
    /** Narrow workers the role may run. */
    subagents: Type.Optional(Type.Array(SubagentDeclaration, { minItems: 1 })),
    /** What each request keeps from the transcript. */
    historyFilter: Type.Optional(HistoryFilterDeclaration),
    /** Mask sample amounts in skills and references. Default true when the role has an engine. */
    maskAmounts: Type.Optional(Type.Boolean()),
    /** Purposes that may run on the office's small model. */
    modelTiers: Type.Optional(
      Type.Object(
        { small: Type.Array(Text(120), { minItems: 1 }) },
        { additionalProperties: false },
      ),
    ),
    /** Subject kinds the role should remember. */
    memorySubjects: Type.Optional(Type.Array(Type.Enum([...MEMORY_SUBJECTS]), { minItems: 1 })),
    /** Tool groups: only the group for the current ticket type is offered. */
    toolGroups: Type.Optional(Type.Array(ToolGroupDeclaration, { minItems: 1 })),
  },
  { additionalProperties: false },
);

/** The `officehum.json` schema, version 1. */
export const ManifestSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    schemaVersion: Type.Literal(MANIFEST_SCHEMA_VERSION),
    id: KebabId,
    name: Text(64),
    department: Type.Enum([...DEPARTMENTS]),
    role: Text(120),
    defaultModel: ModelDeclaration,
    runtimes: Type.Optional(Type.Array(RuntimeDeclaration)),
    engine: Type.Optional(EngineDeclaration),
    tools: Type.Array(ToolDeclaration),
    commands: Type.Optional(Type.Array(CommandDeclaration)),
    connectors: Type.Array(KebabId),
    approvals: Type.Array(ApprovalDeclaration),
    limits: Type.Optional(Type.Record(Type.String(), LimitDeclaration)),
    channels: Type.Array(Type.Enum([...CHANNELS])),
    accepts: Type.Array(AcceptDeclaration),
    /** Ticket types this role hands to other roles, and when. */
    dispatches: Type.Optional(Type.Array(DispatchDeclaration)),
    /** What this role never does, and what it does instead. */
    mayNot: Type.Optional(Type.Array(MayNotDeclaration)),
    /** How the role decides what each request sees. */
    contextPlan: Type.Optional(ContextPlanDeclaration),
    skills: Type.Array(SkillDeclaration),
    evals: Text(256),
  },
  { additionalProperties: false },
);

export type AgentManifest = Static<typeof ManifestSchema>;
export type Department = (typeof DEPARTMENTS)[number];
export type Channel = (typeof CHANNELS)[number];
export type ToolDeclaration = Static<typeof ToolDeclaration>;
export type ApprovalDeclaration = Static<typeof ApprovalDeclaration>;
export type LimitDeclaration = Static<typeof LimitDeclaration>;
export type AcceptDeclaration = Static<typeof AcceptDeclaration>;
export type SkillDeclaration = Static<typeof SkillDeclaration>;
export type ModelDeclaration = Static<typeof ModelDeclaration>;
export type ParameterDeclaration = Static<typeof ParameterDeclaration>;
export type ConditionDeclaration = Static<typeof ConditionDeclaration>;
export type RuntimeDeclaration = Static<typeof RuntimeDeclaration>;
export type EngineDeclaration = Static<typeof EngineDeclaration>;
export type CommandDeclaration = Static<typeof CommandDeclaration>;
export type DispatchDeclaration = Static<typeof DispatchDeclaration>;
export type MayNotDeclaration = Static<typeof MayNotDeclaration>;
export type RetrievalSourceDeclaration = Static<typeof RetrievalSourceDeclaration>;
export type SubagentDeclaration = Static<typeof SubagentDeclaration>;
export type HistoryFilterDeclaration = Static<typeof HistoryFilterDeclaration>;
export type ToolGroupDeclaration = Static<typeof ToolGroupDeclaration>;
export type ContextPlanDeclaration = Static<typeof ContextPlanDeclaration>;

/**
 * The limit a condition's value names, or `undefined` when the value is a literal. A named limit is
 * resolved from the manifest's default and the business's overlay before it is compared.
 */
export function limitName(value: ConditionDeclaration["value"]): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const name = (value as { limit?: unknown }).limit;
  return typeof name === "string" ? name : undefined;
}

/**
 * Validates parsed `officehum.json` content: the schema, then the rules that span fields (no
 * duplicates, no reserved tool names, approvals and skills that refer to what the manifest declares).
 */
export function validateManifest(
  value: unknown,
  source = MANIFEST_FILE,
): Validation<AgentManifest> {
  const issues = schemaIssues(ManifestSchema, value, source);
  if (issues.length > 0) return { ok: false, issues };

  const manifest = value as AgentManifest;
  const crossIssues = crossFieldIssues(manifest, source);
  return crossIssues.length > 0
    ? { ok: false, issues: crossIssues }
    : { ok: true, value: manifest, issues: [] };
}

function crossFieldIssues(manifest: AgentManifest, source: string): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ source, path, message });

  const duplicates = <T>(
    list: readonly T[],
    key: (item: T) => string,
    field: string,
    what: string,
  ) => {
    const seen = new Set<string>();
    list.forEach((item, index) => {
      const name = key(item);
      if (seen.has(name))
        add(joinPath(field, index), `${what} ${show(name)} is declared more than once`);
      seen.add(name);
    });
  };

  duplicates(manifest.tools, (tool) => tool.name, "tools", "tool");
  duplicates(manifest.approvals, (approval) => approval.id, "approvals", "approval");
  duplicates(manifest.accepts, (accept) => accept.type, "accepts", "ticket type");
  duplicates(manifest.dispatches ?? [], (dispatch) => dispatch.type, "dispatches", "ticket type");
  duplicates(manifest.skills, (skill) => skill.id, "skills", "skill");
  duplicates(manifest.connectors, (connector) => connector, "connectors", "connector");
  duplicates(manifest.channels, (channel) => channel, "channels", "channel");
  duplicates(
    manifest.contextPlan?.retrieval?.sources ?? [],
    (source) => source.id,
    "contextPlan.retrieval.sources",
    "retrieval source",
  );
  duplicates(
    manifest.contextPlan?.subagents ?? [],
    (subagent) => subagent.id,
    "contextPlan.subagents",
    "sub-agent",
  );
  duplicates(
    manifest.contextPlan?.toolGroups ?? [],
    (group) => group.id,
    "contextPlan.toolGroups",
    "tool group",
  );

  // A role either accepts a ticket type or hands it off, never both.
  const accepted = new Set(manifest.accepts.map((accept) => accept.type));
  (manifest.dispatches ?? []).forEach((dispatch, index) => {
    if (accepted.has(dispatch.type)) {
      add(
        `dispatches[${index}].type`,
        `${show(dispatch.type)} is also a type this role accepts; a role accepts a type or hands it off, never both — remove the accept or the dispatch`,
      );
    }
  });

  for (const name of Object.keys(manifest.limits ?? {})) {
    if (!SNAKE_NAME.test(name)) {
      add(joinPath("limits", name), 'must be named in snake_case, like "large_invoice"');
    }
  }

  const reserved = new Set<string>(RESERVED_TOOL_NAMES);
  const sdkTools = new Set<string>(SDK_TOOL_NAMES);
  const skills = new Set(manifest.skills.map((skill) => skill.id));
  manifest.tools.forEach((tool, index) => {
    if (reserved.has(tool.name)) {
      add(
        joinPath(joinPath("tools", index), "name"),
        `${show(tool.name)} is provided by ${sdkTools.has(tool.name) ? "the SDK" : "the Office"}; choose another name`,
      );
    }
    if (tool.skill !== undefined && !skills.has(tool.skill)) {
      add(
        joinPath(joinPath("tools", index), "skill"),
        `${show(tool.skill)} is not a declared skill`,
      );
    }
  });

  const tools = new Set(manifest.tools.map((tool) => tool.name));
  decisionIssues(manifest, add);
  manifest.approvals.forEach((approval, index) => {
    if (!tools.has(approval.tool)) {
      add(
        joinPath(joinPath("approvals", index), "tool"),
        `${show(approval.tool)} is not a declared tool`,
      );
    }
  });

  doneIssues(manifest, add);
  engineIssues(manifest, add);
  return issues;
}

/**
 * The wisdom rule, for every role: an unsafe tool states exactly one approval decision — an approval
 * in `approvals`, or a `noApproval` note saying why it needs none — and a safe tool states neither.
 */
function decisionIssues(manifest: AgentManifest, add: (path: string, message: string) => void) {
  const approved = new Set(manifest.approvals.map((approval) => approval.tool));
  manifest.tools.forEach((tool, index) => {
    const at = `tools[${index}]`;
    const approval = approved.has(tool.name);
    const note = tool.noApproval !== undefined;
    if (tool.replay === "unsafe" && approval && note) {
      add(
        at,
        `${show(tool.name)} is unsafe and states two approval decisions; keep an approval in approvals[], or noApproval, never both`,
      );
      return;
    }
    if (tool.replay === "unsafe" && !approval && !note) {
      add(
        at,
        `${show(tool.name)} is unsafe and states no approval decision; add an approval in approvals[], or a noApproval note saying why it needs none`,
      );
      return;
    }
    if (tool.replay === "safe" && note) {
      add(
        `${at}.noApproval`,
        `${show(tool.name)} is safe, so noApproval does not apply; remove it (noApproval explains an unsafe tool that needs no approval)`,
      );
    }
  });
}

/** `{ticket.id}` and `{ticket.data.<path>}` are the only interpolation a completion argument may use. */
const INTERPOLATION =
  /^\{ticket\.(?:id|data\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}$/;

/**
 * Completion evidence must name a tool of this role that is safe — the host runs it, never the model
 * — and interpolate only `{ticket.id}` and `{ticket.data.<path>}`.
 */
function doneIssues(manifest: AgentManifest, add: (path: string, message: string) => void) {
  const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  manifest.accepts.forEach((accept, index) => {
    accept.done?.forEach((entry, doneIndex) => {
      const at = `accepts[${index}].done[${doneIndex}]`;
      if ("tool" in entry) {
        const tool = tools.get(entry.tool);
        if (tool === undefined)
          add(
            `${at}.tool`,
            `${show(entry.tool)} is not a declared tool; completion evidence names a safe tool of this role`,
          );
        else if (tool.replay !== "safe")
          add(
            `${at}.tool`,
            `${show(entry.tool)} is unsafe; completion evidence runs a declared safe tool in the host, never the model`,
          );
      }
      if (!("args" in entry) || entry.args === undefined) return;
      for (const [flag, value] of Object.entries(entry.args)) {
        if (typeof value !== "string") continue;
        for (const placeholder of value.match(/\{[^{}]*\}/g) ?? []) {
          if (INTERPOLATION.test(placeholder)) continue;
          add(
            `${at}.args.${flag}`,
            `${show(placeholder)} is not an interpolation; the only two are {ticket.id} and {ticket.data.<path>}`,
          );
        }
      }
    });
  });
}

/**
 * Rules for engine-backed roles: engine tools and commands need an engine, the engine's program must
 * be a declared runtime (so a host knows to install it, e.g. python3), and approval conditions must
 * name parameters the tool declares.
 */
function engineIssues(manifest: AgentManifest, add: (path: string, message: string) => void) {
  const runtimes = manifest.runtimes ?? [];
  runtimes.forEach((runtime, index) => {
    if (semver.validRange(runtime.version) === null) {
      add(
        `runtimes[${index}].version`,
        `must be a version range like ">=3.10" (got ${show(runtime.version)})`,
      );
    }
  });
  const declaredRuntimes = new Set(runtimes.map((runtime) => runtime.name));

  const program = manifest.engine?.command[0];
  if (program !== undefined && !program.includes("/") && !declaredRuntimes.has(program)) {
    add(
      "engine.command[0]",
      `${show(program)} must be declared in runtimes, e.g. { "name": ${show(program)}, "version": ">=3.10" }, so hosts know to provide it`,
    );
  }

  manifest.tools.forEach((tool, index) => {
    const at = (field: string) => joinPath(joinPath("tools", index), field);
    if (tool.engine === undefined) {
      if (tool.parameters !== undefined)
        add(
          at("parameters"),
          "are only used by engine tools; declare engine too, or define the tool's parameters in code",
        );
      return;
    }
    if (manifest.engine === undefined)
      add(at("engine"), "needs the manifest's engine to be declared");
    if (tool.description === undefined)
      add(at("description"), "is required for an engine tool: it is all the model reads about it");
    for (const [name, parameter] of Object.entries(tool.parameters ?? {})) {
      if (!SNAKE_NAME.test(name)) {
        add(at(`parameters.${name}`), 'must be named in snake_case, like "period"');
      }
      const numeric = parameter.type === "number" || parameter.type === "integer";
      if (parameter.enum?.some((value) => (typeof value === "number") !== numeric)) {
        add(
          at(`parameters.${name}.enum`),
          `values must match the parameter's type ${show(parameter.type)}`,
        );
      }
    }
  });

  const toolsByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const declaredLimits = new Set(Object.keys(manifest.limits ?? {}));
  manifest.approvals.forEach((approval, index) => {
    const parameters = toolsByName.get(approval.tool)?.parameters;
    approval.when?.forEach((condition, conditionIndex) => {
      const at = `approvals[${index}].when[${conditionIndex}]`;
      if (parameters !== undefined && !(condition.arg in parameters)) {
        add(`${at}.arg`, `${show(condition.arg)} is not a parameter of ${show(approval.tool)}`);
      }
      const limit = limitName(condition.value);
      if (limit !== undefined) {
        // A named limit replaces a numeric threshold, so it needs one of the numeric comparisons.
        if (!["gt", "gte", "lt", "lte"].includes(condition.op)) {
          add(
            `${at}.value`,
            `names a limit, which needs "gt", "gte", "lt" or "lte" (op is ${show(condition.op)}); use a literal value instead`,
          );
        }
        if (!declaredLimits.has(limit)) {
          add(`${at}.value`, `${show(limit)} is not a declared limit`);
        }
        return;
      }
      if (condition.op === "in" && !Array.isArray(condition.value)) {
        add(`${at}.value`, 'must be a list when op is "in"');
      }
      if (
        ["gt", "gte", "lt", "lte"].includes(condition.op) &&
        typeof condition.value !== "number"
      ) {
        add(`${at}.value`, `must be a number when op is ${show(condition.op)}`);
      }
    });
  });

  (manifest.commands ?? []).forEach((_command, index) => {
    if (manifest.engine === undefined)
      add(`commands[${index}]`, "needs the manifest's engine to be declared");
  });
  const commandNames = new Set<string>();
  (manifest.commands ?? []).forEach((command, index) => {
    if (commandNames.has(command.name))
      add(`commands[${index}]`, `command ${show(command.name)} is declared more than once`);
    commandNames.add(command.name);
  });
}
