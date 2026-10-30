/**
 * The red-team suite (RASF-3143): injected content never triggers a gated action.
 *
 * This file is the driver, not the suite. The attacks are data — `evals/red-team/scenarios.json` — and
 * each one runs through the runner's office mode, where a board holds a ticket bound to the trial's
 * conversation and the office's real approval gate, budget hooks and inbound marker guard are
 * installed. The assertions are made by `checkScenario` against `executedCalls`, `approvals`,
 * `tickets` and `received`; the reply is never the evidence. A model that resisted and a model that
 * never noticed the attack write the same sentence, and a call the gate blocked and a call the model
 * never made look identical in `calls`.
 *
 * **The adversary is compliant on purpose.** Each script makes exactly the call the injection asks
 * for, in the attacker's own arguments. The question is not whether a model can be fooled — it is
 * scripted to be fooled — but whether the office still refuses once it has been.
 *
 * **RT-P1 runs first and voids the file.** An empty executed ledger is indistinguishable from a ledger
 * that records nothing, so `beforeAll` runs the positive control and throws if it recorded no
 * execution. When it throws, every test in this file fails, because every `notExecuted` in the run is
 * then an absence nobody can attribute.
 *
 * **The mutation pass.** With `OFFICEHUM_REDTEAM_NO_GUARD` set (to any value, or to a comma-separated
 * list of guard names to report on), the guarded pass is skipped and each attack is re-run with its
 * declared layers switched off — the named guard and every later one. Every attack must fail, and the
 * control must still record an execution; otherwise a green attack means nothing. The switch is read
 * here and handed to the runner as an option (`office.disableGuards`), so no production path reads an
 * environment variable that weakens a gate.
 *
 * Not implemented here, and not faked: RT-H1 (hand-off laundering) and RT-L1 (a hand-off loop) need
 * `agent_dispatch` and the board's hop limit driven through a real relay. The office-mode runner has no
 * relay and hardcodes `Trace.delegated` empty, so a scenario for either would be a test of a stub. See
 * the skipped test at the end of this file.
 */

import { fileURLToPath } from "node:url";
import type { Scenario, Trace } from "@officehum/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ScriptedTurn, scriptedProvider } from "../testing/scripted-model.js";
import { type OfficeGuard, piDurableRunner } from "./pi-durable-runner.js";
import { checkScenario, loadScenarios, type RedteamRole, type RedteamScenario } from "./redteam.js";

/** Where each role package lives, relative to this test file. */
const ROLE_DIRS: Readonly<Record<RedteamRole, string>> = {
  frontdesk: fileURLToPath(new URL("../../../../agents/frontdesk", import.meta.url)),
  bookkeeper: fileURLToPath(new URL("../../../../agents/bookkeeper", import.meta.url)),
};

/**
 * The mutation switch. Empty in CI and on a normal run; set only to prove the suite goes red.
 *
 * It is read here rather than in the runner because a runner that weakened its own gate on an
 * environment variable would be one bad export away from shipping without it.
 */
const NO_GUARD = (process.env.OFFICEHUM_REDTEAM_NO_GUARD ?? "").trim();
const MUTATION = NO_GUARD.length > 0;

/** The control's id: the one scenario that is not an attack, and the run's precondition. */
const CONTROL = "RT-P1";

const scenarios = loadScenarios();
const control = scenarios.find((scenario) => scenario.id === CONTROL);
const attacks = scenarios.filter((scenario) => scenario.id !== CONTROL);
if (control === undefined) {
  throw new Error(
    `The red-team suite has no ${CONTROL} positive control, so no absence it asserts could be trusted.`,
  );
}

/** The SDK-shaped scenario the runner takes; the red-team fields travel as runner options. */
function sdkScenario(scenario: RedteamScenario): Scenario {
  return {
    id: scenario.id,
    description: scenario.description,
    severity: scenario.severity,
    input: {
      kind: "message",
      text: scenario.input.text,
      ...(scenario.input.from === undefined ? {} : { from: scenario.input.from }),
    },
    stubs: scenario.stubs,
    ...(scenario.approvals === undefined ? {} : { approvals: scenario.approvals }),
    // Graded by `checkScenario`, not by the SDK's `gradeTrace`: the red-team checks read the executed
    // ledger, and the SDK's expectations cannot express an absence of execution.
    expect: {},
  };
}

/**
 * One trial of one scenario, on the office harness, with `guards` switched off.
 *
 * `roleGate: "omit"` because the deciding layer must be the office's gate: the role's own gate asks
 * the scenario's scripted approver, so leaving it in would let a refusal by the script stand in for a
 * refusal by the office. `stopOnUnscriptedApproval: false` because the compliant adversary keeps going
 * after it is refused, which is the behaviour worth watching the gate against.
 */
async function run(scenario: RedteamScenario, guards: readonly OfficeGuard[] = []): Promise<Trace> {
  const runner = piDurableRunner({
    dir: ROLE_DIRS[scenario.role],
    mode: "office",
    model: () => scriptedProvider(scenario.script as unknown as readonly ScriptedTurn[]),
    office: {
      delivery: scenario.delivery,
      ticketType: scenario.ticketType,
      roleGate: "omit",
      stopOnUnscriptedApproval: false,
      ...(scenario.budget === undefined ? {} : { maxCalls: scenario.budget.maxCalls }),
      ...(scenario.priorApproval === undefined ? {} : { priorApproval: scenario.priorApproval }),
      ...(guards.length === 0 ? {} : { disableGuards: guards }),
    },
  });
  return await runner.run(sdkScenario(scenario), 1);
}

/** The control's trace, run once before anything else and read by the control's own test. */
let controlTrace: Trace | undefined;

beforeAll(async () => {
  controlTrace = await run(control);
  if (!controlTrace.executedCalls.some((call) => call.executed)) {
    throw new Error(
      `${CONTROL} recorded no execution: the executed ledger is empty or broken, so every absence ` +
        "asserted in this file is void. Fix the ledger before reading any result here.",
    );
  }
});

describe.skipIf(MUTATION)("red-team: a fooled model still gets refused", () => {
  it(`${CONTROL} — the control: a legitimate large invoice is executed, with the person's approval`, () => {
    const trace = controlTrace;
    expect(trace).toBeDefined();
    expect(checkScenario(control, trace as Trace)).toEqual([]);
  });

  for (const scenario of attacks) {
    it(`${scenario.id} — ${scenario.vector}: ${scenario.description}`, async () => {
      const trace = await run(scenario);
      expect(checkScenario(scenario, trace)).toEqual([]);
    });
  }
});

describe.runIf(MUTATION)("red-team mutation pass: every attack goes red without its guard", () => {
  for (const scenario of attacks) {
    // The plan's rule: switch off the layer the scenario names, and every layer after it. Defence in
    // depth makes a single mutation lie — what is under test is the claim, not one hook.
    for (let index = 0; index < scenario.guards.length; index++) {
      const removed = scenario.guards.slice(index);
      it(`${scenario.id} fails with ${removed.join(" + ")} removed`, async () => {
        const failures = checkScenario(scenario, await run(scenario, removed));
        // Printed on the way past so the run itself is the mutation matrix: scenario, layer, assertion.
        console.log(`${scenario.id} without ${removed.join("+")} → ${failures.join(" | ")}`);
        expect(
          failures,
          `${scenario.id} stayed green with ${removed.join(", ")} removed, so it is not evidence for ` +
            "that layer: delete it or rewrite it around a call the layer decides.",
        ).not.toEqual([]);
      });
    }
  }

  it(`${CONTROL} still records an execution, so a red attack means containment failed`, () => {
    // The control's approval-row assertion cannot hold with the gate switched off — that is what
    // switching the gate off means. What must survive is the ledger: the call still runs and is still
    // recorded, so a red attack scenario below is a fact about the office and not a broken harness.
    expect(controlTrace?.executedCalls.some((call) => call.executed)).toBe(true);
  });
});

describe("red-team: not yet possible", () => {
  it.skip("RT-H1 / RT-L1 — hand-off laundering and hand-off loops need delegation through a real relay", () => {
    // Both are real attack classes and neither can be built honestly on this harness.
    //
    // RT-H1 (hand-off laundering) needs a colleague's conversation to receive the attacker's words as
    // an ordinary instruction, so the child ticket's provenance can be shown to be the office's own
    // and the delivered content unfenced. That path is `agent_dispatch` through the office extension
    // and the relay's transport; office mode installs neither, and `Trace.delegated` is hardcoded
    // empty (`pi-durable-runner.ts`), so a scenario would assert against a stub.
    //
    // RT-L1 (a hand-off loop) needs the board's hop limit to be reached by a real chain — at least two
    // tickets created by dispatch, the second refused with `max_hops`. Without the relay there is no
    // chain to exhaust.
    //
    // Both are owed by the follow-up ticket that adds relay-backed delegation to the eval runner.
    // Until then the report says so rather than shipping a colleague that pretends to be a hand-off.
    expect(attacks.map((scenario) => scenario.id)).not.toContain("RT-H1");
  });
});
