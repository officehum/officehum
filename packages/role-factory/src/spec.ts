/**
 * `ROLE_SPEC.md`: the one reviewable document a role is generated from, organised by the four layers
 * — context and knowledge inform the agent, wisdom and workflow control it. The interview writes it;
 * the generator (RASF-3099) reads it and writes the role package. There is no mapping layer: the
 * fields the spec shares with `officehum.json` keep the manifest's names, so what a person reviews is
 * what the generator writes.
 *
 * `parseRoleSpec` reports every problem a document has at once, each with the path it sits at and the
 * layer it belongs to. See docs/design/role-spec.md.
 */

import {
  type AgentManifest,
  CHANNELS,
  DEPARTMENTS,
  type FourLayer,
  type Issue,
  MANIFEST_SCHEMA_VERSION,
  OverlaySettingsSchema,
  ScenarioSchema,
  schemaIssues,
  THINKING_LEVELS,
  type Validation,
} from "@officehum/sdk";
import { type Static, Type } from "typebox";
import { parse as parseYaml } from "yaml";
import {
  businessConcerns,
  contextIssues,
  declarationIssues,
  evalIssues,
  knowledgeIssues,
  layerForPath,
  type Mapping,
  mapping,
  separationIssues,
  wisdomIssues,
  workflowIssues,
} from "./rules.js";

/** The file the interview writes and the generator reads. */
export const ROLE_SPEC_FILE = "ROLE_SPEC.md";

/** The spec format this parser reads. */
export const ROLE_SPEC_SCHEMA_VERSION = 1;

/** Where the generator writes the spec's scenarios: the manifest's `evals`, a directory of files. */
export const EVALS_DIR = "evals";

const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const KebabId = Type.String({
  pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$",
  maxLength: 64,
  "x-hint": 'kebab-case, like "note-keeper"',
});
const SnakeName = Type.String({
  pattern: "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
  maxLength: 64,
  "x-hint": 'snake_case, like "search_notes"',
});
const TicketType = Type.String({
  pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
  maxLength: 64,
  "x-hint": 'a dotted ticket type, like "note.add"',
});

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

/** A tool the role registers: a code tool, or an engine tool built from its declaration. */
const ToolDeclaration = Type.Object(
  {
    name: SnakeName,
    replay: Type.Enum(["safe", "unsafe"]),
    skill: Type.Optional(KebabId),
    /** What the model reads about the tool. Required for engine tools, which have no code. */
    description: Type.Optional(Text(1000)),
    engine: Type.Optional(EngineArgs),
    parameters: Type.Optional(Type.Record(Type.String(), ParameterDeclaration)),
    guidelines: Type.Optional(Type.Array(Text(300))),
    /** Why this unsafe tool needs no approval, e.g. "internal note; no outside effect". */
    noApproval: Type.Optional(Text(300)),
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

const ModelDeclaration = Type.Object(
  {
    provider: Text(64),
    modelId: Text(128),
    thinkingLevel: Type.Optional(Type.Enum([...THINKING_LEVELS])),
  },
  { additionalProperties: false },
);

/**
 * A number the business sets: the role declares the limit with a description and a default; the
 * business's value for it goes in `business.settings`.
 */
const LimitDeclaration = Type.Object(
  { description: Text(300), default: Type.Number() },
  { additionalProperties: false },
);

/** A condition's value that names a limit, e.g. `{ "limit": "long_note" }`, instead of a number. */
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

/** An approval an unsafe tool's call waits for, with the conditions that make it apply. */
const ApprovalDeclaration = Type.Object(
  {
    id: SnakeName,
    tool: SnakeName,
    description: Text(200),
    when: Type.Optional(Type.Array(ConditionDeclaration, { minItems: 1 })),
  },
  { additionalProperties: false },
);

/** Values a completion-evidence entry passes; a string may interpolate the ticket. */
const EvidenceArguments = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);

/** One piece of completion evidence: something that must check out before a ticket is done. */
const CompletionEvidence = Type.Union(
  [
    Type.Object(
      { engine: EngineArgs, args: Type.Optional(EvidenceArguments) },
      { additionalProperties: false },
    ),
    Type.Object(
      { tool: SnakeName, args: Type.Optional(EvidenceArguments), expect: Type.Literal("found") },
      { additionalProperties: false },
    ),
    Type.Object({ file: Text(128) }, { additionalProperties: false }),
    Type.Object({ person: Type.Literal(true) }, { additionalProperties: false }),
  ],
  {
    "x-hint":
      'must be one of: { "engine": ["subcommand", …], "args": { "flag": "{ticket.data.<path>}" } }, { "tool": "NAME", "args": {…}, "expect": "found" }, { "file": "NAME" }, or { "person": true }',
  },
);

/** A ticket type the role accepts, with the evidence that makes one done. */
const AcceptDeclaration = Type.Object(
  {
    type: TicketType,
    description: Text(200),
    /** Every entry must pass before a ticket of this type is done. */
    done: Type.Optional(Type.Array(CompletionEvidence)),
  },
  { additionalProperties: false },
);

/** An operator view: runs the engine and shows the result, without the model. */
const CommandDeclaration = Type.Object(
  { name: KebabId, description: Text(200), engine: EngineArgs },
  { additionalProperties: false },
);

/** One reference file a skill points to, written below `skills/<id>/references/`. */
const ReferenceDeclaration = Type.Object(
  { path: Text(128), content: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** One thing to try, and what it did instead, with the enforcement that makes it hold. */
const MayNotDeclaration = Type.Object(
  {
    action: Text(200),
    instead: Text(300),
    /** `approval:<id>`, `no_tool` or `person_only`; see docs/design/role-spec.md. */
    enforced_by: Type.String({
      pattern: "^(approval:[a-z][a-z0-9]*(_[a-z0-9]+)*|no_tool|person_only)$",
      "x-hint": '"approval:<id>", "no_tool" or "person_only"',
    }),
  },
  { additionalProperties: false },
);

/** What the role may do, what it never does, and how each prohibition is enforced. */
const AuthorityDeclaration = Type.Object(
  { may: Type.Array(Text(200)), may_not: Type.Array(MayNotDeclaration) },
  { additionalProperties: false },
);

/**
 * The role: identity and capabilities, in the manifest's own names. `limits` is here as well as in
 * `officehum.json`, because the values a business sets in `business.settings` must be values for a
 * limit the role declares.
 */
const RoleBlock = Type.Object(
  {
    id: KebabId,
    name: Text(64),
    department: Type.Enum([...DEPARTMENTS]),
    role: Text(120),
    defaultModel: ModelDeclaration,
    runtimes: Type.Optional(Type.Array(RuntimeDeclaration)),
    engine: Type.Optional(EngineDeclaration),
    tools: Type.Array(ToolDeclaration),
    connectors: Type.Array(KebabId),
    channels: Type.Array(Type.Enum([...CHANNELS])),
    limits: Type.Optional(Type.Record(SnakeName, LimitDeclaration)),
  },
  { additionalProperties: false },
);

/** Extra lines for APPEND_SYSTEM.md; the generator adds the standard rules itself. */
const ContextBlock = Type.Object(
  { append_system: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);

/** A bundled skill: `skills/<id>/SKILL.md`, and the reference files it points to. */
const SkillDeclaration = Type.Object(
  {
    id: KebabId,
    /** The Agent Skills description: what the skill does and when to use it. */
    description: Text(1024),
    enabled_by_default: Type.Boolean(),
    instructions: Type.String({ minLength: 1 }),
    references: Type.Optional(Type.Array(ReferenceDeclaration)),
  },
  { additionalProperties: false },
);

const KnowledgeBlock = Type.Object(
  { skills: Type.Array(SkillDeclaration) },
  { additionalProperties: false },
);

const WisdomBlock = Type.Object(
  { approvals: Type.Array(ApprovalDeclaration), authority: AuthorityDeclaration },
  { additionalProperties: false },
);

const WorkflowBlock = Type.Object(
  {
    accepts: Type.Array(AcceptDeclaration),
    commands: Type.Optional(Type.Array(CommandDeclaration)),
  },
  { additionalProperties: false },
);

/** One business's specifics: written to an overlay, never to the package. */
const BusinessBlock = Type.Object(
  {
    name: Text(64),
    /** Lines the business adds to its own AGENTS.md, in its overlay. */
    agents_md: Type.Optional(Type.String({ minLength: 1 })),
    /** The business's overlay `settings.json`, including its values for the role's limits. */
    settings: Type.Optional(OverlaySettingsSchema),
  },
  { additionalProperties: false },
);

/**
 * The `ROLE_SPEC.md` frontmatter schema, version 1. Unknown keys are refused at every level: a field
 * the generator would not write is a field nobody would review.
 */
export const RoleSpecSchema = Type.Object(
  {
    schema: Type.Literal(ROLE_SPEC_SCHEMA_VERSION),
    role: RoleBlock,
    context: Type.Optional(ContextBlock),
    knowledge: Type.Optional(KnowledgeBlock),
    wisdom: WisdomBlock,
    workflow: WorkflowBlock,
    evals: Type.Array(ScenarioSchema),
    business: Type.Optional(BusinessBlock),
  },
  { additionalProperties: false },
);

export type RoleSpecFrontmatter = Static<typeof RoleSpecSchema>;
export type RoleBlockDeclaration = Static<typeof RoleBlock>;
export type SkillDeclaration = Static<typeof SkillDeclaration>;
export type WisdomDeclaration = Static<typeof WisdomBlock>;
export type WorkflowDeclaration = Static<typeof WorkflowBlock>;
export type BusinessDeclaration = Static<typeof BusinessBlock>;

/** A parsed, valid spec: the frontmatter plus the body, the role's AGENTS.md context. */
export interface RoleSpec extends RoleSpecFrontmatter {
  readonly body: string;
}

/** The frontmatter and the body, or nothing when the document does not start with frontmatter. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parses and checks one `ROLE_SPEC.md`, reporting every problem at once: the schema, the four layers,
 * the declarations and references inside the spec, the separation of the role from one business, and
 * the eval scenarios in the SDK's own format. `source` names the document in every issue.
 */
export function parseRoleSpec(text: string, source = ROLE_SPEC_FILE): Validation<RoleSpec> {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return {
      ok: false,
      issues: [
        {
          source,
          path: "",
          message:
            "must start with YAML frontmatter between --- lines: the role, the four layers and the evals",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ok: false,
      issues: [{ source, path: "", message: `frontmatter is not valid YAML: ${message}` }],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, issues: [{ source, path: "", message: "frontmatter must be a mapping" }] };
  }

  const frontmatter = parsed as Mapping;
  const body = (match[2] ?? "").trim();
  // A separation rule says where a misplaced concern belongs, so its message replaces the schema's
  // "is not a known field" at the same key, which says less.
  const separation = separationIssues(frontmatter, source, businessConcerns(frontmatter));
  const explained = new Set(separation.map((issue) => issue.path));

  const issues: Issue[] = [
    ...schemaIssues(RoleSpecSchema, frontmatter, source)
      .filter((issue) => !(issue.message === "is not a known field" && explained.has(issue.path)))
      .map((issue) => withLayer(issue, layerForPath(issue.path))),
    ...contextIssues(frontmatter, body, source),
    ...knowledgeIssues(frontmatter, source),
    ...wisdomIssues(frontmatter, source),
    ...workflowIssues(frontmatter, source),
    ...declarationIssues(frontmatter, source),
    ...separation,
    ...evalIssues(frontmatter, mergedForChecks(frontmatter), source),
  ];

  const all = once(issues);
  if (all.some((issue) => issue.severity !== "warning")) return { ok: false, issues: all };
  return { ok: true, value: { ...(frontmatter as RoleSpecFrontmatter), body }, issues: all };
}

/**
 * The merged `officehum.json`: `role`, `wisdom.approvals`, `workflow.accepts` and `workflow.commands`,
 * field names unchanged. `wisdom.authority` is not a manifest field — the generator turns it into the
 * "You may" and "You may not" sections of AGENTS.md — and `business` is written to an overlay, never
 * to the package. `evals` is the directory the generator writes the spec's scenarios into.
 */
export function manifestFromRoleSpec(spec: RoleSpec): AgentManifest {
  const { role, wisdom, workflow, knowledge } = spec;
  // This merge also runs over a *broken* spec, so the checker can report every problem at once: a
  // missing `authority` is one of those problems, not a reason to throw here.
  const prohibitions = Array.isArray(wisdom.authority?.may_not) ? wisdom.authority.may_not : [];
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: role.id,
    name: role.name,
    department: role.department,
    role: role.role,
    defaultModel: role.defaultModel,
    ...(role.runtimes === undefined ? {} : { runtimes: role.runtimes }),
    ...(role.engine === undefined ? {} : { engine: role.engine }),
    tools: role.tools,
    ...(workflow.commands === undefined ? {} : { commands: workflow.commands }),
    connectors: role.connectors,
    approvals: wisdom.approvals,
    ...(role.limits === undefined ? {} : { limits: role.limits }),
    channels: role.channels,
    accepts: workflow.accepts,
    // `enforced_by` is a factory check, not a manifest field: the manifest carries what the role
    // never does and what it does instead, which is what the agent card and the prompt show.
    ...(prohibitions.length === 0
      ? {}
      : {
          mayNot: prohibitions.map((entry) => ({
            action: entry.action,
            instead: entry.instead,
          })),
        }),
    skills: (knowledge?.skills ?? []).map((skill) => ({
      id: skill.id,
      enabledByDefault: skill.enabled_by_default,
    })),
    evals: EVALS_DIR,
  };
}

/**
 * The merged manifest for the SDK's own suite check, when the frontmatter carries enough of it. The
 * check reads the names the spec declares, so a value the schema has refused elsewhere in the
 * document is harmless here; it is a value to check a suite against, never the generator's output.
 */
function mergedForChecks(frontmatter: Mapping): AgentManifest | undefined {
  const role = mapping(frontmatter.role);
  const wisdom = mapping(frontmatter.wisdom);
  const workflow = mapping(frontmatter.workflow);
  const knowledge = mapping(frontmatter.knowledge);
  const sound =
    role !== undefined &&
    Array.isArray(role.tools) &&
    Array.isArray(role.connectors) &&
    Array.isArray(role.channels) &&
    wisdom !== undefined &&
    Array.isArray(wisdom.approvals) &&
    workflow !== undefined &&
    Array.isArray(workflow.accepts) &&
    (knowledge === undefined || Array.isArray(knowledge.skills));
  if (!sound) return undefined;
  return manifestFromRoleSpec(frontmatter as unknown as RoleSpec);
}

/** An issue with the layer its path belongs to, when it belongs to one. */
function withLayer(issue: Issue, layer: FourLayer | undefined): Issue {
  return layer === undefined ? issue : { ...issue, layer };
}

/** Every issue once: the schema and the SDK's suite check can name the same problem. */
function once(issues: readonly Issue[]): Issue[] {
  const seen = new Set<string>();
  const unique: Issue[] = [];
  for (const issue of issues) {
    const key = `${issue.path}\u0000${issue.message}\u0000${issue.layer ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}
