/**
 * A fixture role for approver values: two gated tools whose approvals ask the person for a
 * figure, the mechanism's proof before any catalog role adopts it.
 *
 * - `give_credit` (`any_credit`): fixed bounds, 1 to 50000 cents, no facts reader. Its `reason` and
 *   `suggestedCents` arguments are the model's; the tool never uses a figure from them.
 * - `adjust_pay` (`pay_adjustment`): bounds read from the role's records by its facts reader, minus
 *   and plus the employee's gross, so the minimum is negative.
 *
 * Each tool records what it wrote to `writes`, with the cents and who entered them. Used by the SDK's
 * gate tests and, through the office's tests, with the runtime's remote approver.
 */

import {
  defineExtension,
  defineTool,
  type Extension,
  type HookRegistration,
} from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import {
  APPROVED_FACTS_ARG,
  APPROVED_VALUE_ARG,
  type ApprovalFactsReader,
  type Approver,
  approvalGate,
  approvedFacts,
  approvedFactsParameter,
  approvedValue,
  approvedValueParameter,
  declaredFacts,
} from "../approvals.js";
import type { AgentManifest } from "../manifest.js";

export const VALUE_DESK = "value-desk";

export const valueDeskManifest: AgentManifest = {
  schemaVersion: 1,
  id: VALUE_DESK,
  name: "Value Desk",
  department: "finance",
  role: "Gives credits and adjusts pay at the amounts a person approves.",
  defaultModel: { provider: "scripted", modelId: "scripted-1" },
  tools: [
    { name: "give_credit", replay: "unsafe" },
    { name: "adjust_pay", replay: "unsafe" },
  ],
  connectors: [],
  approvals: [
    {
      id: "any_credit",
      tool: "give_credit",
      description: "Approve this credit and enter its amount",
      value: { name: "creditCents", label: "Credit to give", min: 1, max: 50_000 },
    },
    {
      id: "pay_adjustment",
      tool: "adjust_pay",
      description: "Approve a correction to this employee's pay and enter it",
      value: {
        name: "adjustmentCents",
        label: "Adjustment to gross pay",
        minFact: "lowestCents",
        maxFact: "highestCents",
      },
    },
  ],
  channels: [],
  accepts: [],
  skills: [],
  evals: "evals",
};

/** One write a tool made: what, how many cents, and who entered them. */
export interface ValueWrite {
  readonly tool: string;
  readonly subject: string;
  readonly cents: number;
  readonly by: string | null;
}

export interface ValueDeskOptions {
  readonly approve?: Approver | undefined;
  /** Each employee's gross for the run, in cents: the records `adjust_pay`'s bounds are read from. */
  readonly gross: Map<string, number>;
  /** Where the tools record their writes. */
  readonly writes: ValueWrite[];
  /** Hooks after the approval gate, e.g. one a test uses to stop a run between the gate and a tool. */
  readonly hooks?: readonly HookRegistration[];
}

/** The fixture role: one extension, its approval gate, and its facts reader. */
export function valueDesk(options: ValueDeskOptions): {
  readonly extensions: readonly Extension[];
  readonly agent: { readonly model: AgentManifest["defaultModel"]; extensions: Extension[] };
  readonly approvalFacts: Readonly<Record<string, ApprovalFactsReader>>;
} {
  const payFacts = declaredFacts(
    ["employee", "grossCents", "lowestCents", "highestCents"],
    async (args) => {
      const employee = String(args.employee);
      const gross = options.gross.get(employee);
      if (gross === undefined) throw new Error(`There is no employee ${employee} on the run.`);
      return {
        summary: `Adjust ${employee}'s pay (gross ${gross} cents)`,
        facts: { employee, grossCents: gross, lowestCents: -gross, highestCents: gross },
      };
    },
  );
  const giveCredit = defineTool({
    name: "give_credit",
    description: "Gives a client a credit; a person approves it and enters the amount.",
    parameters: obj(
      {
        client: str(),
        reason: opt(str()),
        suggestedCents: opt(num()),
        [APPROVED_VALUE_ARG]: approvedValueParameter(),
      },
      { open: true },
    ),
    replay: "unsafe",
    execute: async (args) => {
      const value = approvedValue(args, "creditCents");
      options.writes.push({
        tool: "give_credit",
        subject: args.client,
        cents: value.cents,
        by: value.by,
      });
      return { output: [{ type: "text", text: `credited ${value.cents} cents` }] };
    },
  });
  const adjustPay = defineTool({
    name: "adjust_pay",
    description:
      "Corrects an employee's pay on the run; a person approves it and enters the amount.",
    parameters: obj(
      {
        employee: str(),
        [APPROVED_FACTS_ARG]: approvedFactsParameter(),
        [APPROVED_VALUE_ARG]: approvedValueParameter(),
      },
      { open: true },
    ),
    replay: "unsafe",
    execute: async (args) => {
      if (approvedFacts(args) === undefined) {
        return { isError: true, output: [{ type: "text", text: "no approved facts" }] };
      }
      const value = approvedValue(args, "adjustmentCents");
      options.writes.push({
        tool: "adjust_pay",
        subject: args.employee,
        cents: value.cents,
        by: value.by,
      });
      return { output: [{ type: "text", text: `adjusted by ${value.cents} cents` }] };
    },
  });
  const approvalFacts = { pay_adjustment: payFacts };
  const extension = defineExtension({
    name: VALUE_DESK,
    tools: [giveCredit, adjustPay],
    hooks: [
      approvalGate({
        approvals: valueDeskManifest.approvals,
        approve: options.approve,
        facts: approvalFacts,
      }),
      ...(options.hooks ?? []),
    ],
  });
  return {
    extensions: [extension],
    agent: { model: valueDeskManifest.defaultModel, extensions: [extension] },
    approvalFacts,
  };
}
