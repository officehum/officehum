/**
 * The Office Manager's entry point: the factory a host calls to get the role.
 *
 * ```ts
 * import officeManager from "@officehum/office-manager";
 *
 * const role = officeManager({ overlays: ["./my-office-manager"] });
 * for (const extension of role.extensions) registry.install(extension);
 * const root = await harness.root(context, { agent: role.agent });
 * ```
 *
 * The package brings its own prompt and skills, and nothing else: the role declares no tools, no
 * approvals and no connectors, so it answers in words on a bare Pi Durable harness and writes
 * nothing. In an office the host adds the inbox and hand-off tools — the `agent_inbox` and
 * `agent_dispatch` of the office extension — which is the only thing that changes. Nothing here
 * needs Office Hum, so the same bundle runs in a bare Pi Durable harness.
 */

import { fileURLToPath } from "node:url";
import { type DefinedRole, defineRole } from "@officehum/sdk";
import manifest from "../officehum.json" with { type: "json" };

export interface OfficeManagerOptions {
  /** Overlay directories, lowest first: the business's AGENTS.md, skills, settings and limits. */
  readonly overlays?: readonly string[];
}

export default function officeManager({ overlays }: OfficeManagerOptions = {}): DefinedRole {
  return defineRole({
    packageDir: fileURLToPath(new URL("..", import.meta.url)),
    manifest,
    ...(overlays === undefined ? {} : { overlays }),
  });
}
