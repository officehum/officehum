/**
 * @officehum/office — the runtime that hosts many agents in one Pi Durable harness.
 *
 * `./adapter/` opens and owns the Pi Durable harness (RASF-3120). The workboard (`./board/`), relay
 * (`./relay/`), office extension (`./extension/`) and runtime process (`./runtime/`) build on it.
 */

export type { AgentManifest, Department } from "@officehum/sdk";
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
  type CalendarOperation,
  type CalendarOperationKind,
  type CalendarOperationResult,
  type CalendarStore,
  type Cancellation,
  openCalendarStore,
} from "./calendar-store.js";
export {
  type ConsoleDeliveryReceipt,
  type ConsoleMessage,
  type ConsoleMessageChannel,
  type ConsoleMessageIntent,
  type ConsoleMessenger,
  openConsoleMessenger,
} from "./console-messenger.js";
export { createDemoModels } from "./demo-model.js";
export { type EmailGatewayOptions, emailGateway } from "./email-gateway.js";
export {
  EVAL_EXTENSION_NAME,
  type EvalModel,
  type PiDurableRunnerOptions,
  piDurableRunner,
} from "./evals/pi-durable-runner.js";
export {
  createGoogleCalendarHost,
  type DecisionStore,
  type GoogleCalendarHost,
} from "./google-calendar.js";
export {
  InboundConversationDoc,
  type InboundRoute,
  InboundRoutesDoc,
  type InboundSession,
  inboundAwareApprover,
  openInboundSession,
} from "./inbound-session.js";
export {
  type Booking,
  canonicalAppointmentStart,
  type LocalCalendar,
  openLocalCalendar,
} from "./local-calendar.js";
export {
  bindMessengerIdentity,
  CONSOLE_MESSENGER_IDENTITY,
  type ConsoleMessengerIdentity,
  hasDurableMessagingState,
  type MessengerIdentity,
  messengerIdentityString,
  parseMessengerIdentity,
  type ResendMessengerIdentity,
  readMessengerIdentity,
} from "./messenger-identity.js";
export {
  OFFICE_CONFIG_FILE,
  type OfficeConfig,
  type OfficeConfigFile,
  openOfficeConfig,
} from "./office-config.js";
export {
  ResendInboundAdapter,
  type ResendInboundAdapterOptions,
} from "./resend-adapter.js";
export {
  canonicalJson as canonicalInboundJson,
  canonicalMailbox,
  type InboundAttachment,
  type NormalizedInboundEmail,
  normalizeReceivedEmail,
  parseReceivingEvent,
  type ReceivingEvent,
  type SignedWebhookHeaders,
  verifySvixWebhook,
} from "./resend-inbound.js";
export {
  durableInboundReplyApprover,
  type InboundAuthority,
  type InboxSummary,
  type InternalResendInbox,
  openResendInbox,
  type ResendInboundOptions,
  type ResendInbox,
  readInboundAuthority,
  readInboundInbox,
  type StoredInboundReceipt,
} from "./resend-inbox.js";
export {
  type InboundDisposition,
  type InboundOutcome,
  openResendListener,
  type ResendListener,
  type SmsInboundMessage,
  type TwilioHookOptions,
} from "./resend-listener.js";
export {
  openResendMessenger,
  type ResendDeliveryReceipt,
  type ResendMessageIntent,
  type ResendMessenger,
  type ResendMessengerOptions,
} from "./resend-messenger.js";
export { type EmailOutboundIntent, ResendOutbound } from "./resend-outbound.js";
export {
  createResendReplyMessenger,
  type ReplyMessenger,
  type ReplyTarget,
  type ResendReplyMessenger,
} from "./resend-replies.js";
export {
  type LoadedRole,
  type LoadRoleOptions,
  loadRole,
  RESERVED_ROLE_OPTIONS,
} from "./roles/load-role.js";
export {
  openRoleRun,
  type RoleRun,
  type RoleRunOptions,
  type RoleRunResult,
} from "./roles/run-role.js";
export { boardSenderResolver } from "./roles/sender.js";
export {
  type ApprovalAuditRecord,
  type ApprovalCaller,
  type ApprovalsHost,
  approvalAudit,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  RemoteApprovals,
  RUN_STOPPED,
  TIMED_OUT,
} from "./runtime/approvals.js";
export {
  approvalTimeoutsMs,
  COMPANY_FACTS,
  loadOfficeRoles,
  type OfficeCompany,
  type OfficeConnection,
  type OfficeDocumentFormat,
  type OfficeFile,
  type OfficeFileRole,
  parseOfficeFile,
  readOfficeCompany,
  readOfficeFile,
} from "./runtime/office-file.js";
export {
  type AgentInfo,
  type AgentToolInfo,
  openRuntime,
  type Runtime,
  type RuntimeOptions,
  type ServeRuntimeOptions,
  scopedRequestId,
  serveRuntime,
} from "./runtime/runtime.js";
export {
  emailInText,
  openSmsIntake,
  SMS_CALLBACK_TYPE,
  SMS_CREATED_BY,
  SmsConversationDoc,
  type SmsIntake,
  type SmsIntakeOptions,
  type SmsRoute,
  SmsRoutesDoc,
  smsEnvelope,
} from "./sms-intake.js";
export {
  type ConnectorIdentity,
  type GoogleConnectorIdentity,
  type HostedSoloRole,
  hasDurableLocalState,
  type LocalConnectorIdentity,
  type OpenSoloOptions,
  openSolo,
  readConnectorIdentity,
  readSoloDocument,
  type SoloResult,
  type SoloSession,
} from "./solo.js";
export { PI_DURABLE_VERSION } from "./version.js";
