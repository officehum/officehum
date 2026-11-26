/**
 * Environment variables no role's program is ever given: the office's own secrets. A role
 * manifest names the variables its MCP servers and CLIs need (`mcpServers.*.env`, `clis.*.env`), and
 * the host copies their values into the child's environment; these names are refused there, by the
 * manifest validator and again where each child's environment is built. Names compare ignoring
 * letter case, because on Windows `officehum_secret_key` is the same variable.
 *
 * Only names fixed in code are listed. A host whose own secrets are configured by name (a connection
 * vendor's key variable, a webhook signing secret's) passes those names to the places it builds child
 * environments, which refuse them the same way (`isReservedEnvName`'s `extra`).
 */

import type { AgentManifest } from "./manifest.js";

/** The key that opens every model key the office stores. */
export const OFFICE_SECRET_KEY_VARIABLE = "OFFICEHUM_SECRET_KEY";

export const RESERVED_ENV_NAMES: readonly string[] = [OFFICE_SECRET_KEY_VARIABLE];

/** Whether `name` is one of the office's own secrets, or one the host names in `extra`. */
export function isReservedEnvName(name: string, extra: readonly string[] = []): boolean {
  const upper = name.toUpperCase();
  return [...RESERVED_ENV_NAMES, ...extra].some((reserved) => reserved.toUpperCase() === upper);
}

/** The refusal for a reserved name, said the same way everywhere. */
export function reservedEnvMessage(name: string): string {
  return `${name} is the office's own secret, which no role's program is given`;
}

/** Every reserved name a manifest's MCP servers and CLIs ask for, with its path. */
export function reservedEnvIssues(
  manifest: Pick<AgentManifest, "mcpServers" | "clis">,
  extra: readonly string[] = [],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const named: [string, Readonly<Record<string, object>>][] = [
    ["mcpServers", manifest.mcpServers ?? {}],
    ["clis", manifest.clis ?? {}],
  ];
  for (const [field, entries] of named) {
    for (const [id, entry] of Object.entries(entries)) {
      const env: readonly string[] =
        "env" in entry ? ((entry.env as string[] | undefined) ?? []) : [];
      env.forEach((name, index) => {
        if (isReservedEnvName(name, extra)) {
          issues.push({ path: `${field}.${id}.env[${index}]`, message: reservedEnvMessage(name) });
        }
      });
    }
  }
  return issues;
}
