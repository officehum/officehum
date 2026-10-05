/**
 * @officehum/office — the runtime that hosts many agents in one Pi Durable harness.
 *
 * M0 scaffold. The Pi Durable adapter lands in RASF-3065; the workboard,
 * relay and board tools land in M1 (RASF-3066, RASF-3067, RASF-3068).
 */

export type { AgentManifest, Department } from "@officehum/sdk";

/** Pi Durable range this release is tested against. */
export const PI_DURABLE_RANGE = "~1.0.2";
