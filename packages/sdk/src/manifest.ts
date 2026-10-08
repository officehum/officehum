/**
 * `officehum.json`: the metadata Office Hum reads from a role package without running its code.
 * Pi Durable ignores this file. See docs/design/agent-package.md.
 */

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

const ToolDeclaration = Type.Object(
  {
    name: SnakeName,
    replay: Type.Enum(["safe", "unsafe"]),
    skill: Type.Optional(KebabId),
  },
  { additionalProperties: false },
);

const ApprovalDeclaration = Type.Object(
  { id: SnakeName, tool: SnakeName, description: Text(200) },
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
    tools: Type.Array(ToolDeclaration),
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

  return issues;
}
