/**
 * `@officehum/cli` as a library: the one-agent command line and the pieces a host's command line
 * builds on. The office's runs its commands through `runCli` with a `CliExtension`. The
 * `officehum` executable is `./index.ts`.
 */

export { formatCents, parseCents, readApprovalValue } from "./cents.js";
export {
  type CliDependencies,
  type CliExtension,
  type CliIo,
  interruptCli,
  type RegisterSession,
  runCli,
} from "./cli.js";
export {
  DEFAULT_EVAL_MAX_OUTPUT_TOKENS,
  type EvalOffice,
  EXIT_INCOMPLETE,
  type InstalledCompany,
} from "./eval.js";
export { JUDGE_CHECK_USAGE } from "./judge-check.js";
export { loweredLines, type StandingLowered } from "./lowered.js";
export { dataPackFor, declaresDataTools, importDataPack, OFFICE_PACKS } from "./packs.js";
export {
  LIVE_PROVIDERS,
  liveModels,
  liveProvider,
  parseModelRef,
  runModels,
  type StoredModelKeys,
} from "./run.js";
export { createTerminalIo, type TerminalInterrupt, terminalExitCode } from "./terminal-io.js";
export { UsageError } from "./usage-error.js";
