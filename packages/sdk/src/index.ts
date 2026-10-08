/**
 * @officehum/sdk — build portable Pi Durable role agents.
 *
 * A role is a Pi Durable extension. It ships Pi's familiar files (AGENTS.md, APPEND_SYSTEM.md,
 * skills/) with its tools, and installs into any Pi Durable 1.0.x harness, with or without Office
 * Hum. Overlay directories with the same layout customize it without touching the package. This SDK
 * adds what Pi Durable does not have: `defineRole` (role files, skills and overlays as Pi Durable
 * sections and tools), the approval gate, the `officehum.json` manifest, checks that keep a role
 * portable and consistent, engines (a role's deterministic core, run as a subprocess), and the eval
 * format. It depends only on Pi Durable and pi-ai (as peers),
 * `typebox`, `semver` and `yaml`.
 *
 * See docs/design/agent-package.md.
 */

export {
  checkAgent,
  INSTRUCTIONS_SECTION_KEY,
  type RoleBundle,
  type RoleFactory,
  skillExtensionName,
} from "./agent.js";
export {
  type ApprovalDecision,
  type ApprovalGateOptions,
  type ApprovalRequest,
  type Approver,
  approvalGate,
  conditionsHold,
  type HookContext,
  isApprovalGate,
  type ToolArguments,
} from "./approvals.js";
export {
  type CommandEngineOptions,
  checkRuntimes,
  commandEngine,
  type Engine,
  EngineError,
  type EngineFinding,
  type EngineResult,
  type EngineRunOptions,
  engineArgs,
  engineFromManifest,
  engineTools,
  formatEngineResult,
  type ManifestEngineOptions,
  runOperatorCommand,
  type StubEngine,
  stubEngine,
} from "./engine.js";
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
  type CommandDeclaration,
  type ConditionDeclaration,
  DEPARTMENTS,
  type Department,
  type EngineDeclaration,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  ManifestSchema,
  type ModelDeclaration,
  type ParameterDeclaration,
  RESERVED_TOOL_NAMES,
  type RuntimeDeclaration,
  SDK_TOOL_NAMES,
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
  type OverlaySettings,
  OverlaySettingsSchema,
  type ResolvedRole,
  type ResolvedSkill,
  type ResolveRoleOptions,
  ROLE_FILES,
  resolveRoleFiles,
  type SourcedText,
} from "./resources.js";
export {
  type DefinedRole,
  type DefineRoleOptions,
  defineRole,
  ROLE_SECTION_KEYS,
  RoleFilesError,
} from "./role.js";
export {
  INSTRUCTION_FILE_TYPES,
  type ReadSkillOptions,
  readSkill,
  readSkillFile,
  SKILL_FILE,
  type Skill,
  skillFolders,
} from "./skills.js";
