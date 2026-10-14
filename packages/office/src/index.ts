/**
 * @officehum/office — the runtime that hosts many agents in one Pi Durable harness.
 *
 * M0 scaffold. The Pi Durable adapter lands in RASF-3065; the workboard,
 * relay and board tools land in M1 (RASF-3066, RASF-3067, RASF-3068).
 */

export type { AgentManifest, Department } from "@officehum/sdk";

/** Exact Pi Durable version this release is built and tested against. Bumped by the upgrade pipeline. */
export const PI_DURABLE_VERSION = "1.0.2";

export { createDemoModels } from "./demo-model.js";
export {
  createGoogleCalendarHost,
  type DecisionStore,
  type GoogleCalendarHost,
} from "./google-calendar.js";
export {
  type Booking,
  type LocalCalendar,
  openLocalCalendar,
} from "./local-calendar.js";
export {
  type ConnectorIdentity,
  type GoogleConnectorIdentity,
  type LocalConnectorIdentity,
  type OpenSoloOptions,
  openSolo,
  readConnectorIdentity,
  type SoloResult,
  type SoloSession,
} from "./solo.js";
