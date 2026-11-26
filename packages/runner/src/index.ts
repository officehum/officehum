/**
 * @officehum/runner: runs one role package on a Pi Durable harness.
 *
 * `./adapter/` is the only code in Office Hum that opens and drives a Pi Durable `Harness`
 * (`./adapter/imports.test.ts` enforces it). On it sit what running one role needs: loading and
 * checking a role package (`loadRole`), one-role runs over a SQLite file (`openRoleRun`), the local
 * calendar a Front Desk books into, the bare eval runner (`piDurableRunner`, which a host such as
 * the office extends through `TrialHost`) with its judge and cost accounting, and key-error redaction
 * for live providers. The scripted model a test or a keyless run uses is `@officehum/runner/testing`.
 */

export {
  type Office,
  type OfficeConversationOptions,
  type OfficeEvent,
  type OfficeStorage,
  type OfficeSubmitOptions,
  type OpenOfficeOptions,
  openOffice,
  ROOT_CONVERSATION_ID,
  ROOT_KEY,
  readStoredDocument,
} from "./adapter/index.js";
export {
  type Booking,
  type CalendarOperation,
  type CalendarOperationKind,
  type CalendarOperationResult,
  type CalendarStore,
  type Cancellation,
  openCalendarStore,
} from "./calendar-store.js";
export { cappedModels, modelUsageOf, outputLimitError, usageTotal } from "./evals/eval-cost.js";
export { bareEvalMemory, type EvalMemory, seedScenarioRecords } from "./evals/eval-memory.js";
export { type EvalModel, modelJudge } from "./evals/judge.js";
export {
  EMPTY_LEDGER_ERROR,
  EVAL_EXTENSION_NAME,
  type HostTrial,
  type OpenedHostTrial,
  type PiDurableRunnerOptions,
  piDurableRunner,
  sampleCompanyInStubs,
  type TrialContext,
  type TrialHost,
  type TrialLedger,
} from "./evals/runner.js";
export {
  canonicalAppointmentStart,
  type LocalCalendar,
  openLocalCalendar,
} from "./local-calendar.js";
export { redactKeyErrors } from "./models/redact.js";
export {
  type LoadedRole,
  type LoadRoleOptions,
  loadRole,
  RESERVED_ROLE_OPTIONS,
  reservedHandbookOverlay,
} from "./roles/load-role.js";
export {
  answerText,
  openRoleRun,
  type RoleRun,
  type RoleRunOptions,
  type RoleRunResult,
} from "./roles/run-role.js";
export { bounded } from "./shared/validation.js";
export { PI_DURABLE_VERSION } from "./version.js";
