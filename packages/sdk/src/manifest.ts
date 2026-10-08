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
  },
  { additionalProperties: false },
);

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

const AcceptDeclaration = Type.Object(
  { type: TicketType, description: Text(200) },
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
    channels: Type.Array(Type.Enum([...CHANNELS])),
    accepts: Type.Array(AcceptDeclaration),
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
export type AcceptDeclaration = Static<typeof AcceptDeclaration>;
export type SkillDeclaration = Static<typeof SkillDeclaration>;
export type ModelDeclaration = Static<typeof ModelDeclaration>;
export type ParameterDeclaration = Static<typeof ParameterDeclaration>;
export type ConditionDeclaration = Static<typeof ConditionDeclaration>;
export type RuntimeDeclaration = Static<typeof RuntimeDeclaration>;
export type EngineDeclaration = Static<typeof EngineDeclaration>;
export type CommandDeclaration = Static<typeof CommandDeclaration>;

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
  duplicates(manifest.skills, (skill) => skill.id, "skills", "skill");
  duplicates(manifest.connectors, (connector) => connector, "connectors", "connector");
  duplicates(manifest.channels, (channel) => channel, "channels", "channel");

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
  manifest.approvals.forEach((approval, index) => {
    if (!tools.has(approval.tool)) {
      add(
        joinPath(joinPath("approvals", index), "tool"),
        `${show(approval.tool)} is not a declared tool`,
      );
    }
  });

  engineIssues(manifest, add);
  return issues;
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
      if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name)) {
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
  manifest.approvals.forEach((approval, index) => {
    const parameters = toolsByName.get(approval.tool)?.parameters;
    approval.when?.forEach((condition, conditionIndex) => {
      const at = `approvals[${index}].when[${conditionIndex}]`;
      if (parameters !== undefined && !(condition.arg in parameters)) {
        add(`${at}.arg`, `${show(condition.arg)} is not a parameter of ${show(approval.tool)}`);
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
