/**
 * What lowering a safeguard means, computed rather than judged (docs/design/overlay-rules.md).
 *
 * A **guard** is code or manifest data that makes an agent ask a person, stop, or lack a capability:
 * an approval, a named limit that guards (`limitDirection`), a writing tool the role ships switched
 * off, and the role's own instructions (replacing them removes its "You may not" section). Prompt
 * text the business adds, skills and the model are not guards.
 *
 * Every comparison is three-way: the **defaults** (the package alone, as it ships), the **current**
 * configuration and a **candidate**. A change `lowers` a guard when the candidate is looser than both
 * current and the defaults; that is the change a host applies only with the owner's acknowledgement.
 * This module acknowledges and records nothing: it only says what moved, in plain words.
 */

import { type AgentManifest, limitDirection, type ToolDeclaration } from "./manifest.js";
import { loosens, type ResolvedRole, ROLE_FILES } from "./resources.js";

export type GuardKind = "approval" | "limit" | "tool" | "instructions";

/**
 * How a change moves a guard. Only `lowers` needs an acknowledgement.
 *
 * - `lowers`: looser than now, and looser than the role ships it;
 * - `loosens`: looser than now, but still tighter than the role ships it;
 * - `tightens`: tighter than now, and not back at the default (a guard still lowered, only less);
 * - `restores`: back at the default.
 */
export type GuardEffect = "lowers" | "loosens" | "tightens" | "restores";

/**
 * A guard's state: a limit's number, or whether an approval is on, a writing tool is switched on, or
 * the role's instructions are replaced.
 */
export type GuardValue = number | boolean;

/** One guard a change moves. */
export interface GuardChange {
  /** Stable and readable, `<kind>.<name>`: `approval.pay_bill`, `limit.large_invoice`. */
  readonly id: string;
  readonly kind: GuardKind;
  /** The approval id, limit name, tool name, or the instructions file. */
  readonly name: string;
  readonly effect: GuardEffect;
  readonly from: GuardValue;
  readonly to: GuardValue;
  /** What the role ships with. */
  readonly default: GuardValue;
  /** The change in plain words: what a person acknowledges. */
  readonly sentence: string;
}

/** A guard the configuration holds below its default. */
export interface LoweredGuard {
  readonly id: string;
  readonly kind: GuardKind;
  readonly name: string;
  readonly value: GuardValue;
  readonly default: GuardValue;
  readonly sentence: string;
}

/** The three configurations a change is judged between. */
export interface GuardStates {
  /** The package alone: what the role ships with. */
  readonly defaults: ResolvedRole;
  /** The configuration in effect. */
  readonly current: ResolvedRole;
  /** The configuration the change would make. */
  readonly candidate: ResolvedRole;
}

/** How one guard is read, compared and described. */
interface Guard {
  readonly id: string;
  readonly kind: GuardKind;
  readonly name: string;
  read(role: ResolvedRole): GuardValue;
  /** Whether `a` lets more through than `b`. */
  looser(a: GuardValue, b: GuardValue): boolean;
  /** The sentence for a change from `from` to `to`, made in `candidate`. */
  change(from: GuardValue, to: GuardValue, shipped: GuardValue, candidate: ResolvedRole): string;
  /** The sentence for a guard standing at `value`. */
  standing(value: GuardValue, shipped: GuardValue): string;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 });
const figure = (value: GuardValue) => (typeof value === "number" ? NUMBER.format(value) : "");
const offWhenTrue = (a: GuardValue, b: GuardValue) => a === false && b === true;
const onWhenFalse = (a: GuardValue, b: GuardValue) => a === true && b === false;

/** Whether a tool changes something: unsafe, or declared as writing. */
const writes = (tool: ToolDeclaration) => tool.replay === "unsafe" || tool.writes === true;

/** Every guard the role has, in a stable order: approvals, limits, tools, instructions. */
function guardsOf(manifest: AgentManifest, defaults: ResolvedRole): Guard[] {
  const agent = manifest.name;
  const approvals: Guard[] = manifest.approvals.map((approval) => ({
    id: `approval.${approval.id}`,
    kind: "approval",
    name: approval.id,
    read: (role) => role.approvals.some((on) => on.id === approval.id),
    looser: offWhenTrue,
    change: (_from, to) =>
      to === false
        ? `Stop asking a person before: ${approval.description}. ${agent} will do this on its own.`
        : `Ask a person again before: ${approval.description}.`,
    standing: () => `${agent} does not ask a person before: ${approval.description}.`,
  }));

  const limits: Guard[] = Object.entries(manifest.limits ?? {}).flatMap(([name, limit]) => {
    const direction = limitDirection(manifest, name);
    if (direction === "none") return [];
    return [
      {
        id: `limit.${name}`,
        kind: "limit" as const,
        name,
        read: (role: ResolvedRole) => role.limits[name] ?? limit.default,
        looser: (a: GuardValue, b: GuardValue) => loosens(direction, Number(a), Number(b)),
        change: (from: GuardValue, to: GuardValue, shipped: GuardValue) => {
          const verb = Number(to) > Number(from) ? "Raise" : "Lower";
          const unknown =
            direction === "both" && to !== shipped
              ? " Office Hum cannot tell which way is safer for this limit, so it treats any change as lowering a safeguard."
              : "";
          return `${verb} "${limit.description}" from ${figure(from)} to ${figure(to)}; the role ships with ${figure(shipped)}.${unknown}`;
        },
        standing: (value: GuardValue, shipped: GuardValue) =>
          `"${limit.description}" is ${figure(value)}; the role ships with ${figure(shipped)}.`,
      },
    ];
  });

  const tools: Guard[] = manifest.tools.filter(writes).map((tool) => ({
    id: `tool.${tool.name}`,
    kind: "tool",
    name: tool.name,
    read: (role) => available(tool, role),
    looser: onWhenFalse,
    change: (_from, to, _shipped, candidate) => {
      if (to === false) return `Switch off ${tool.name}, as ${agent} ships it.`;
      const covering = candidate.approvals.filter((approval) => approval.tool === tool.name);
      const cover =
        covering.length === 0
          ? "no approval covers it"
          : `${covering.length === 1 ? "its approval" : "its approvals"} ${covering.map((approval) => `"${approval.description}"`).join(" and ")} still ${covering.length === 1 ? "applies" : "apply"}`;
      return `Switch on ${tool.name}, which ${agent} ships switched off. It changes things, and ${cover}.`;
    },
    standing: () => `${tool.name} is switched on; ${agent} ships it switched off.`,
  }));

  const instructions: Guard[] = [
    {
      id: "instructions.agents",
      kind: "instructions",
      name: ROLE_FILES.agents,
      read: (role) => !role.agents.some((part) => part.source === ROLE_FILES.agents),
      looser: onWhenFalse,
      change: (_from, to) =>
        to === true
          ? `Replace ${agent}'s own instructions, including what it says it must never do, with yours. Its approvals and limits still apply.`
          : `Use ${agent}'s own instructions again.`,
      standing: () => `${agent}'s own instructions are replaced by yours.`,
    },
  ];
  // Only a role that ships closing instructions can have them replaced.
  if (defaults.appendSystem?.source === ROLE_FILES.appendSystem) {
    instructions.push({
      id: "instructions.append_system",
      kind: "instructions",
      name: ROLE_FILES.appendSystem,
      read: (role) => role.appendSystem?.source !== ROLE_FILES.appendSystem,
      looser: onWhenFalse,
      change: (_from, to) =>
        to === true
          ? `Replace the closing instructions ${agent} ships with. Its approvals and limits still apply.`
          : `Use the closing instructions ${agent} ships with again.`,
      standing: () => `The closing instructions ${agent} ships with are replaced by yours.`,
    });
  }

  return [...approvals, ...limits, ...tools, ...instructions];
}

/** Whether a declared tool is offered: its skill (if any) is on and no overlay switched it off. */
function available(tool: ToolDeclaration, role: ResolvedRole): boolean {
  if (role.disabledTools.includes(tool.name)) return false;
  if (tool.skill === undefined) return true;
  return role.skills.some((skill) => skill.name === tool.skill && skill.enabled);
}

function effectOf(
  guard: Guard,
  shipped: GuardValue,
  from: GuardValue,
  to: GuardValue,
): GuardEffect {
  if (to === shipped) return "restores";
  if (guard.looser(to, from)) return guard.looser(to, shipped) ? "lowers" : "loosens";
  return "tightens";
}

/** Every guard that moves from `current` to `candidate`, sorted by id. */
export function guardChanges(manifest: AgentManifest, states: GuardStates): GuardChange[] {
  const { defaults, current, candidate } = states;
  return guardsOf(manifest, defaults)
    .flatMap((guard): GuardChange[] => {
      const shipped = guard.read(defaults);
      const from = guard.read(current);
      const to = guard.read(candidate);
      if (from === to) return [];
      return [
        {
          id: guard.id,
          kind: guard.kind,
          name: guard.name,
          effect: effectOf(guard, shipped, from, to),
          from,
          to,
          default: shipped,
          sentence: guard.change(from, to, shipped, candidate),
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every guard `role` holds below the defaults, sorted by id. */
export function loweredGuards(
  manifest: AgentManifest,
  defaults: ResolvedRole,
  role: ResolvedRole,
): LoweredGuard[] {
  return guardsOf(manifest, defaults)
    .flatMap((guard): LoweredGuard[] => {
      const shipped = guard.read(defaults);
      const value = guard.read(role);
      if (!guard.looser(value, shipped)) return [];
      return [
        {
          id: guard.id,
          kind: guard.kind,
          name: guard.name,
          value,
          default: shipped,
          sentence: guard.standing(value, shipped),
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
