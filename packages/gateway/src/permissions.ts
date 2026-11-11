/**
 * Who may do what, from `gateway.json`. Deny by default: `submit`, `approve` and `abort` need a rule
 * naming one of the principal's roles (and, for `submit` and `approve`, the agent). `watch_approvals`
 * needs an approve rule for some agent. `subscribe`, `get_state`, `list_agents` and `ping` need only a
 * signed-in principal, because the runtime scopes every request to the principal that made it.
 */

import type { ClientCommand, Principal } from "@officehum/protocol";
import type { Permissions, RoleList } from "./config.js";

export type Decision =
  | { readonly allowed: true; readonly principal: Principal }
  | { readonly allowed: false; readonly reason: string };

/** Whether a rule's roles include one of the principal's. */
export function covers(roles: RoleList, principal: Principal): boolean {
  return roles.includes("*") || principal.roles.some((role) => roles.includes(role));
}

/**
 * Decides one command for one principal. The principal it returns is the one to forward: for
 * `approve`, its `approvalLimit` is the lower of the token's and the rules', so the runtime enforces
 * the tighter of the two.
 */
/** The approve rules that let this principal decide this agent's approvals. */
function approveRules(permissions: Permissions, principal: Principal, agent: string) {
  return permissions.approve.filter(
    (rule) => covers(rule.roles, principal) && (rule.agents === "*" || rule.agents.includes(agent)),
  );
}

/** Whether the principal may decide this agent's approvals, and so hear of them. */
export function mayApprove(permissions: Permissions, principal: Principal, agent: string): boolean {
  return approveRules(permissions, principal, agent).length > 0;
}

/**
 * Decides one command for one principal. `approvalAgent` is the agent an `approve` command's approval
 * belongs to, which the command itself does not say. The principal returned is the one to forward:
 * for `approve`, its `approvalLimit` is the lower of the token's and the rules', so the runtime
 * enforces the tighter of the two.
 */
export function decide(
  permissions: Permissions,
  principal: Principal,
  command: ClientCommand,
  approvalAgent?: string,
): Decision {
  switch (command.type) {
    case "submit": {
      const allowed = permissions.submit.some(
        (rule) =>
          covers(rule.roles, principal) &&
          (rule.agents === "*" || rule.agents.includes(command.agent)),
      );
      return allowed
        ? { allowed: true, principal }
        : { allowed: false, reason: `You may not submit work to ${command.agent}.` };
    }
    case "approve": {
      const rules =
        approvalAgent === undefined ? [] : approveRules(permissions, principal, approvalAgent);
      if (rules.length === 0) {
        return {
          allowed: false,
          reason: `You may not approve actions${approvalAgent === undefined ? "" : ` for ${approvalAgent}`}.`,
        };
      }
      const ruleLimit = rules.some((rule) => rule.limit === undefined)
        ? undefined
        : Math.max(...rules.map((rule) => rule.limit as number));
      const limits = [ruleLimit, principal.approvalLimit].filter(
        (limit): limit is number => limit !== undefined,
      );
      const { approvalLimit: _ignored, ...rest } = principal;
      return {
        allowed: true,
        principal: limits.length === 0 ? rest : { ...rest, approvalLimit: Math.min(...limits) },
      };
    }
    case "watch_approvals":
      return permissions.approve.some((rule) => covers(rule.roles, principal))
        ? { allowed: true, principal }
        : { allowed: false, reason: "You may not approve actions, so there are none to watch." };
    case "abort":
      return permissions.abort.some((rule) => covers(rule.roles, principal))
        ? { allowed: true, principal }
        : { allowed: false, reason: "You may not abort requests." };
    default:
      return { allowed: true, principal };
  }
}
