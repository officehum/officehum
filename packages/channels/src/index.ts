/**
 * Inbound channels, and the one gateway they all go through (RASF-3160).
 *
 * Two directions, deliberately separate types: `ChannelAdapter` receives, `OutboundAdapter` sends, and
 * the registry holds them in two maps. Nothing in this build implements an outbound SMS adapter, which
 * is the whole of "the office cannot text a customer" — see `NoAdapterError`. There is no outbox and no
 * credential: see `adapter.ts` for why the absence is the enforcement rather than a gap.
 */
export {
  type Ack,
  type ChannelAdapter,
  type E164,
  type InboundMessage,
  type InboundRefusal,
  type InboundRequest,
  type InboundResult,
  parseE164,
} from "./adapter.js";
export {
  ChannelGateway,
  type ChannelGatewayOptions,
  externalProvenance,
  type FenceOptions,
  fence,
  type GatewayCeiling,
  type GatewayOutcome,
  type GatewayResult,
  type GatewayStore,
  type InboundDisposition,
  type InboundProvenance,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
} from "./gateway.js";
export type { InboundIntake } from "./intake.js";
export { type OptOutState, optOutCommand, START_KEYWORDS, STOP_KEYWORDS } from "./optout.js";
export {
  type DeliveryReceipt,
  NoAdapterError,
  type OutboundAdapter,
  type OutboundIntent,
} from "./outbound.js";
export {
  FAKE_NUMBER,
  FakeNumberProvisioner,
  type NumberProvisioner,
  type NumberSink,
} from "./provision.js";
export {
  admitWithin,
  DEFAULT_SMS_RATE_LIMIT,
  type RateLimit,
  type RateLimitStore,
  rateLimitWindow,
} from "./ratelimit.js";
export { ChannelRegistry } from "./registry.js";
export {
  registeredSender,
  resolveBy,
  type SenderResolution,
  type SenderResolver,
  UNKNOWN_SENDER,
  UNKNOWN_SENDERS,
} from "./resolve.js";
export { type ReplyRoute, replyByLine, replyRoute } from "./route.js";
export { twilioSignature, verifyTwilioSignature } from "./signature.js";
export {
  EMPTY_TWIML,
  formParams,
  TWILIO_FORM_CONTENT_TYPE,
  TWIML_CONTENT_TYPE,
  type TwilioAcceptResult,
  TwilioAdapter,
  type TwilioAdapterOptions,
} from "./twilio.js";
