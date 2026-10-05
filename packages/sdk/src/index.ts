/**
 * @officehum/sdk — the contract every Office Hum agent package follows.
 *
 * This is the M0 scaffold. The full manifest schema and validation land in
 * RASF-3064 (SDK and manifest schema).
 */

/** Departments an agent can belong to. The UI groups the team by department. */
export const DEPARTMENTS = [
  "front-office",
  "finance",
  "operations",
  "sales",
  "marketing",
  "people",
] as const;

export type Department = (typeof DEPARTMENTS)[number];

/** Minimal agent manifest. Expanded in RASF-3064. */
export interface AgentManifest {
  /** Stable package-level id, e.g. "frontdesk". */
  id: string;
  /** Display name, e.g. "Front Desk". */
  name: string;
  /** Semver version of the agent package. */
  version: string;
  /** Department this role belongs to. */
  department: Department;
  /** One-line job description shown in the UI. */
  role: string;
}

/** Returns the manifest unchanged, typed. Validation is added in RASF-3064. */
export function defineManifest(manifest: AgentManifest): AgentManifest {
  return manifest;
}
