/**
 * The agent card: a machine-readable description of a role, so other agents and hosts can see who
 * it is, what it accepts, what it hands off, what it can do, and what it never does. Built from the
 * role's `officehum.json` and the business's overlay through `resolveRoleFiles`, so it always
 * matches the agent's real, effective tools: a tool an overlay switches off is absent from the card.
 *
 * A card never carries secrets, overlay settings values, limit amounts or the role's prompt text.
 * See "Context engineering" in docs/design/agent-package.md.
 */

import { type Static, Type } from "typebox";
import type { AgentManifest } from "./manifest.js";
import type { ResolvedRole } from "./resources.js";

/** How a capability touches the business: `reads` changes nothing, `changes` writes something. */
export const CAPABILITY_EFFECTS = ["reads", "changes"] as const;

/** The most a team section's one line for an agent may hold. */
export const CARD_LINE_MAX = 160;

const CapabilitySchema = Type.Object(
  {
    kind: Type.Enum(["skill", "tool"]),
    name: Type.String({ minLength: 1 }),
    /** One line about the capability; a tool that declares none in the manifest has none. */
    description: Type.Optional(Type.String({ minLength: 1 })),
    /** Tools only: `reads` when replay is safe, `changes` when it is unsafe. */
    effect: Type.Optional(Type.Enum([...CAPABILITY_EFFECTS])),
    /** Tools only: the Inbox descriptions of the approvals that gate this tool. */
    approvals: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

const CardAcceptSchema = Type.Object(
  { type: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const CardDispatchSchema = Type.Object(
  { type: Type.String({ minLength: 1 }), when: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const CardMayNotSchema = Type.Object(
  { action: Type.String({ minLength: 1 }), instead: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** An agent card's shape; `agentCard` builds one and hosts read it. */
export const AgentCardSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    department: Type.String({ minLength: 1 }),
    role: Type.String({ minLength: 1 }),
    status: Type.String({ minLength: 1 }),
    accepts: Type.Array(CardAcceptSchema),
    dispatches: Type.Array(CardDispatchSchema),
    capabilities: Type.Array(CapabilitySchema),
    mayNot: Type.Array(CardMayNotSchema),
  },
  { additionalProperties: false },
);

export type AgentCard = Static<typeof AgentCardSchema>;
export type AgentCardCapability = Static<typeof CapabilitySchema>;

export interface AgentCardOptions {
  /** What the office reports the agent is doing; default `"active"`. */
  readonly status?: string;
}

/**
 * Builds the card for an effective role: its skills (switched off ones are absent) and its tools
 * (those an overlay switched off are absent), each with whether it reads or changes, and the
 * approvals that gate it.
 */
export function agentCard(
  manifest: AgentManifest,
  role: ResolvedRole,
  options: AgentCardOptions = {},
): AgentCard {
  const disabled = new Set(role.disabledTools);

  return {
    id: manifest.id,
    name: manifest.name,
    department: manifest.department,
    role: manifest.role,
    status: options.status ?? "active",
    accepts: manifest.accepts.map((accept) => ({
      type: accept.type,
      description: accept.description,
    })),
    dispatches: (manifest.dispatches ?? []).map((dispatch) => ({
      type: dispatch.type,
      when: dispatch.when,
    })),
    capabilities: [
      ...role.skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          kind: "skill" as const,
          name: skill.name,
          description: skill.description,
        })),
      ...manifest.tools
        .filter((tool) => !disabled.has(tool.name))
        .map((tool) => {
          const approvals = manifest.approvals
            .filter((approval) => approval.tool === tool.name)
            .map((approval) => approval.description);
          return {
            kind: "tool" as const,
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            effect: tool.replay === "safe" ? ("reads" as const) : ("changes" as const),
            ...(approvals.length === 0 ? {} : { approvals }),
          };
        }),
    ],
    mayNot: (manifest.mayNot ?? []).map((entry) => ({
      action: entry.action,
      instead: entry.instead,
    })),
  };
}

/** One line for a team section, at most `CARD_LINE_MAX` characters. */
export function formatCardLine(card: AgentCard): string {
  const accepts = card.accepts.map((accept) => accept.type).join(", ");
  const dispatches = card.dispatches.map((dispatch) => dispatch.type).join(", ");
  const line = [
    `${card.name} (${card.department})`,
    `accepts ${accepts === "" ? "nothing" : accepts}`,
    `hands off ${dispatches === "" ? "nothing" : dispatches}`,
  ].join(" · ");
  return line.length <= CARD_LINE_MAX ? line : `${line.slice(0, CARD_LINE_MAX - 1)}…`;
}

/** Compact Markdown for an `agent_card` tool: what the agent accepts, hands off, can do and avoids. */
export function formatCard(card: AgentCard): string {
  const lines: string[] = [
    `# ${card.name}`,
    "",
    `${card.role} · ${card.department} · ${card.status}`,
    "",
    "## Accepts",
    "",
  ];
  lines.push(
    ...(card.accepts.length === 0
      ? ["- Nothing"]
      : card.accepts.map((accept) => `- ${accept.type}: ${accept.description}`)),
    "",
    "## Hands off",
    "",
  );
  lines.push(
    ...(card.dispatches.length === 0
      ? ["- Nothing"]
      : card.dispatches.map((dispatch) => `- ${dispatch.type}: ${dispatch.when}`)),
    "",
    "## Capabilities",
    "",
  );
  lines.push(
    ...(card.capabilities.length === 0
      ? ["- Nothing"]
      : card.capabilities.map((capability) => `- ${capabilityLine(capability)}`)),
    "",
    "## You may not",
    "",
  );
  lines.push(
    ...(card.mayNot.length === 0
      ? ["- Nothing listed"]
      : card.mayNot.map((entry) => `- ${entry.action} — instead, ${entry.instead}`)),
  );
  return `${lines.join("\n")}\n`;
}

/** `name (reads): description`, with approvals called out; a tool's mark comes from its replay. */
function capabilityLine(capability: AgentCardCapability): string {
  const marks = [
    ...(capability.effect === undefined ? [] : [capability.effect]),
    ...(capability.approvals === undefined || capability.approvals.length === 0
      ? []
      : [`needs approval: ${capability.approvals.join("; ")}`]),
  ];
  const head = marks.length === 0 ? capability.name : `${capability.name} (${marks.join("; ")})`;
  return capability.description === undefined ? head : `${head}: ${capability.description}`;
}
