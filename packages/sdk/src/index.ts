/**
 * @officehum/sdk — build portable Pi Durable role agents.
 *
 * A role is a Pi Durable extension written directly with `defineExtension`, `defineTool`, `section`
 * and `hook`. It installs into any Pi Durable 1.0.x harness, with or without Office Hum. This SDK
 * adds what Pi Durable does not have: the `officehum.json` manifest, checks that keep a role portable
 * and consistent with its manifest, the role prompt and approval-gate helpers, and the eval format.
 * It depends only on Pi Durable (as a peer), `typebox` and `semver`.
 *
 * See docs/design/agent-package.md.
 */

export { checkAgent, type RoleBundle, type RoleFactory, skillExtensionName } from "./agent.js";
export {
  type ApprovalDecision,
  type ApprovalGateOptions,
  type ApprovalRequest,
  type Approver,
  approvalGate,
  type HookContext,
  isApprovalGate,
  type ToolArguments,
} from "./approvals.js";
export {
  type AgentRunner,
  type EvalReport,
  formatReport,
  gradeTrace,
  type RunEvalsOptions,
  runEvals,
  type ScenarioReport,
  type Trace,
  type TrialReport,
} from "./evals/run.js";
export {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_TRIALS,
  type EvalSuite,
  type Scenario,
  type ScenarioExpect,
  type ScenarioInput,
  ScenarioSchema,
  SuiteSchema,
  validateSuite,
} from "./evals/suite.js";
export { formatIssue, type Issue, type Validation } from "./issues.js";
export {
  type AcceptDeclaration,
  type AgentManifest,
  type ApprovalDeclaration,
  CHANNELS,
  type Channel,
  DEPARTMENTS,
  type Department,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  ManifestSchema,
  type ModelDeclaration,
  RESERVED_TOOL_NAMES,
  type SkillDeclaration,
  THINKING_LEVELS,
  type ToolDeclaration,
  validateManifest,
} from "./manifest.js";
export {
  PEER_ONLY_PACKAGES,
  PI_DURABLE_PACKAGE,
  PLATFORM_PACKAGES,
  type RolePackage,
  supportsPiDurable,
  validatePackage,
} from "./package.js";
export {
  INSTRUCTIONS_SECTION_KEY,
  ROLE_SECTION_KEYS,
  type RolePrompt,
  roleSections,
} from "./prompt.js";
