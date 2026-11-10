/**
 * Who may do what, from `gateway.json`. Deny by default: `submit`, `approve` and `abort` need a rule
 * naming one of the principal's roles. `subscribe`, `get_state`, `list_agents` and `ping` need only a
 * signed-in principal, because the runtime scopes every request to the principal that made it.
 */

import type { ClientCommand, Principal } from "@officehum/protocol";
import type { Permissions, RoleList } from "./config.js";

export type Decision =
  | { readonly allowed: true; readonly principal: Principal }
  | { readonly allowed: false; readonly reason: string };

function covers(roles: RoleList, principal: Principal): boolean {
  return roles.includes("*") || principal.roles.some((role) => roles.includes(role));
}

/**
 * Decides one command for one principal. The principal it returns is the one to forward: for
 * `approve`, its `approvalLimit` is the lower of the token's and the rules', so the runtime enforces
 * the tighter of the two.
 */
export function decide(
  permissions: Permissions,
  principal: Principal,
  command: ClientCommand,
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
      const rules = permissions.approve.filter((rule) => covers(rule.roles, principal));
      if (rules.length === 0) return { allowed: false, reason: "You may not approve actions." };
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
    case "abort":
      return permissions.abort.some((rule) => covers(rule.roles, principal))
        ? { allowed: true, principal }
        : { allowed: false, reason: "You may not abort requests." };
    default:
      return { allowed: true, principal };
  }
}
