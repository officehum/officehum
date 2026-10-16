/**
 * @officehum/office — the runtime that hosts many agents in one Pi Durable harness.
 *
 * `./adapter/` is the only code here that calls Pi Durable's runtime API (RASF-3120). The workboard,
 * relay and office extension land in M2 (RASF-3066, RASF-3067, RASF-3133), not M1.
 */

export type { AgentManifest, Department } from "@officehum/sdk";

/** Exact Pi Durable version this release is built and tested against. Bumped by the upgrade pipeline. */
export const PI_DURABLE_VERSION = "1.3.0";

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
  type ReceiveResult,
  type ResendInboundOptions,
  type ResendInbox,
  readInboundAuthority,
  readInboundInbox,
  type StoredInboundReceipt,
} from "./resend-inbox.js";
export {
  openResendListener,
  type ResendListener,
} from "./resend-listener.js";
export {
  openResendMessenger,
  type ResendDeliveryReceipt,
  type ResendMessageIntent,
  type ResendMessenger,
  type ResendMessengerOptions,
} from "./resend-messenger.js";
export {
  createResendReplyMessenger,
  type ReplyMessenger,
  type ReplyTarget,
  type ResendReplyMessenger,
} from "./resend-replies.js";
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
