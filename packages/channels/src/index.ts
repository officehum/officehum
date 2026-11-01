/**
 * Inbound channels (RASF-3162).
 *
 * One provider, one direction. Everything here turns a signed webhook into a message the office can act
 * on, and answers the provider with the empty TwiML that tells it to send nothing. There is no outbox,
 * no send member and no credential: see `adapter.ts` for why the absence is the enforcement rather than
 * a gap.
 */
export {
  type ChannelAdapter,
  type E164,
  type InboundMessage,
  type InboundRefusal,
  type InboundRequest,
  type InboundResult,
  parseE164,
} from "./adapter.js";
export { type OptOutState, optOutCommand, START_KEYWORDS, STOP_KEYWORDS } from "./optout.js";
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
export { twilioSignature, verifyTwilioSignature } from "./signature.js";
export {
  EMPTY_TWIML,
  formParams,
  TWILIO_FORM_CONTENT_TYPE,
  TWIML_CONTENT_TYPE,
  TwilioAdapter,
  type TwilioAdapterOptions,
} from "./twilio.js";
