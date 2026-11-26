/**
 * Tools that reach people outside the business. A role declares each one with `outside: true` in
 * `officehum.json`; an approval on such a tool is a floor no overlay may lower yet, because sending to
 * customers without a person reading it first is not available until the owner decides
 * (docs/design/overlay-rules.md, "What no overlay can lower").
 *
 * `SEND_TOOLS` are the two tools a customer channel offers that send (a host's channel mapping check
 * reads them). They reach outside whether or not a role declares it, so the floor
 * and the channel check can never disagree about them; the catalog test holds every catalog role to
 * declaring them too, so the declaration stays the one place a reader looks.
 */
import { type Issue, show } from "./issues.js";
import {
  type AgentManifest,
  type ApprovalDeclaration,
  comparedDirection,
  type LimitDirection,
  limitDirection,
  MANIFEST_FILE,
  type ToolDeclaration,
} from "./manifest.js";

export const SEND_TOOLS: readonly string[] = ["send_message", "reply_message"];

/** Whether a declared tool sends or publishes to someone outside the business. */
export function reachesOutside(tool: Pick<ToolDeclaration, "name" | "outside">): boolean {
  return tool.outside === true || SEND_TOOLS.includes(tool.name);
}

/** The approvals on tools that reach outside the business: each is a floor no overlay may lower. */
export function outsideApprovals(
  manifest: Pick<AgentManifest, "tools" | "approvals">,
): ApprovalDeclaration[] {
  const outside = new Set(manifest.tools.filter(reachesOutside).map((tool) => tool.name));
  return manifest.approvals.filter(
    (approval) => outside.has(approval.tool) || reachesOutside({ name: approval.tool }),
  );
}

/**
 * Which way the outside floor holds a limit, when it does: a limit an approval on an outside tool
 * compares with, or one marked `outside`, may be tightened but never loosened by an overlay.
 * Undefined for a limit the floor does not hold.
 */
export function outsideFloor(
  manifest: AgentManifest,
  name: string,
): Exclude<LimitDirection, "none"> | undefined {
  const compared = comparedDirection(outsideApprovals(manifest), name);
  if (compared !== undefined) return compared;
  if (manifest.limits?.[name]?.outside !== true) return undefined;
  const direction = limitDirection(manifest, name);
  return direction === "none" ? undefined : direction;
}

/** Words that suggest a tool sends or publishes something. A hint for a warning, never a rule. */
const SENDING_WORDS = [
  "send",
  "email",
  "sms",
  "text",
  "post",
  "publish",
  "notify",
  "message",
  "remind",
  "invoice",
];

/**
 * Warnings for writing tools whose name or description suggests they send or publish, with no
 * `outside` declaration. The outside floor rests on that declaration, and only the
 * catalog roles are checked for it, so a role author is told; the role may well be right.
 */
export function outsideHints(manifest: Pick<AgentManifest, "tools">): Issue[] {
  const issues: Issue[] = [];
  manifest.tools.forEach((tool, index) => {
    if (reachesOutside(tool)) return;
    if (tool.replay !== "unsafe" && tool.writes !== true) return;
    const words = [
      ...tool.name.split("_"),
      ...(tool.description ?? "").toLowerCase().split(/[^a-z]+/),
    ];
    const word = SENDING_WORDS.find((stem) => words.some((each) => each.startsWith(stem)));
    if (word === undefined) return;
    issues.push({
      source: MANIFEST_FILE,
      path: `tools[${index}]`,
      severity: "warning",
      message: `${show(tool.name)} changes something and mentions ${show(word)}; if it sends or publishes to people outside the business, declare "outside": true so no overlay can switch its approval off`,
    });
  });
  return issues;
}

/** Said wherever the floor refuses something, so every refusal gives the same reason. */
export const SEND_FLOOR_REASON =
  "sending to customers without a person reading it first is not available yet";
