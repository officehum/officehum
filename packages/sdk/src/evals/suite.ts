/**
 * The eval file format: scenarios with expected outcomes, checked against the role's manifest.
 * See "Evals" in docs/design/agent-package.md.
 */

import { type Static, Type } from "typebox";
import { COMMUNICATION_TOOL_NAMES } from "../communication.js";
import { type Issue, joinPath, schemaIssues, show, type Validation } from "../issues.js";
import { type AgentManifest, type ApprovalDeclaration, CHANNELS } from "../manifest.js";
import {
  CATEGORIES,
  KINDS,
  MEMORY_TOOL_NAMES,
  SOURCE_TYPES,
  STATUSES,
  SUBJECT_PATTERN,
} from "../memory-vocabulary.js";
import { declaredPacks } from "../tool-packs.js";
import { NOT_CONTAINS_ADVICE, notContainsShape } from "./reply-assertions.js";

/** Pass rate the `normal` scenarios of a suite must reach, across all their trials. */
export const DEFAULT_PASS_THRESHOLD = 0.9;

/** Trials per scenario when a scenario does not say. */
export const DEFAULT_TRIALS = 3;

const Id = Type.String({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  maxLength: 80,
  "x-hint": 'kebab-case, like "books-requested-slot"',
});
const Words = Type.Array(Type.String({ minLength: 1 }));
/**
 * A reply prohibition: a phrase in an accepted shape (see `reply-assertions.ts`), or a phrase with
 * the reason no call can prove what it protects, for the rare case no shape fits.
 */
const NotContainsEntry = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    {
      phrase: Type.String({ minLength: 1 }),
      reason: Type.String({
        minLength: 20,
        "x-hint": "a sentence saying why no notCalled, calls or approvalsRequested can prove it",
      }),
    },
    { additionalProperties: false },
  ),
]);

/**
 * A claim about the reply and whether the reply must make it, graded by a judge model.
 * The claim is a declarative sentence about the reply; `validateSuite` checks it beyond its type.
 */
const JudgedAssertion = Type.Object(
  {
    claim: Type.String({ "x-hint": 'a sentence about the reply, like "The reply promises …"' }),
    verdict: Type.Enum(["absent", "present"], { "x-hint": 'must be "absent" or "present"' }),
  },
  { additionalProperties: false },
);

/** The longest claim `validateSuite` accepts: one sentence, not a rubric. */
const MAX_CLAIM_LENGTH = 300;

const MessageInput = Type.Object(
  {
    kind: Type.Literal("message"),
    text: Type.String({ minLength: 1 }),
    channel: Type.Optional(Type.Enum([...CHANNELS])),
    from: Type.Optional(Type.String({ minLength: 1 })),
    /**
     * Where `from` wrote from: `internal` (inside the office, so a colleague on the company record
     * is one) or `external` (an outside channel). Bare mode defaults it to external. In office mode
     * it is the ticket's provenance origin, and with none given office mode defaults to internal, so
     * a staff `from` with no origin is a colleague in office mode and not in bare mode: a scenario
     * that relies on a staff sender says `internal`. Under inbound-email delivery it is ignored: an
     * inbound email is always external.
     */
    origin: Type.Optional(Type.Enum(["internal", "external"])),
  },
  { additionalProperties: false },
);

const TicketInput = Type.Object(
  {
    kind: Type.Literal("ticket"),
    type: Type.String({ minLength: 1 }),
    payload: Type.Record(Type.String(), Type.Unknown()),
    provenance: Type.Optional(Type.Enum(["internal", "external"])),
  },
  { additionalProperties: false },
);

/** A canned tool result. The model still sees the tool's real name, description and parameters. */
/**
 * A stub's structured result, returned beside its text as a real tool returns `details`:
 * how a stubbed lookup verifies a customer the way the tool's manifest `verifies` declares.
 */
const StubDetails = Type.Optional(Type.Record(Type.String(), Type.Unknown()));

const TextStub = Type.Object(
  { text: Type.String(), isError: Type.Optional(Type.Boolean()), details: StubDetails },
  { additionalProperties: false },
);

/**
 * A canned result that depends on the call's arguments: the first entry whose `args` match (the same
 * partial match `expect.calls[].args` uses) answers; `otherwise` answers the rest. An argument given
 * as `{ "includes": "…" }` matches a string argument that contains that text, so a stub can answer
 * every draft that quotes a passage, however the model worded the rest.
 */
const ArgsStub = Type.Object(
  {
    byArgs: Type.Array(
      Type.Object(
        {
          args: Type.Record(Type.String(), Type.Unknown()),
          text: Type.String(),
          isError: Type.Optional(Type.Boolean()),
          details: StubDetails,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    otherwise: Type.Optional(TextStub),
  },
  { additionalProperties: false },
);

const Stub = Type.Union([TextStub, ArgsStub]);
const Stubs = Type.Record(Type.String(), Stub);

const ExpectedCall = Type.Object(
  {
    tool: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /**
     * The value a person approved that the call ran with. `args` matches what the model
     * emitted, which never carries it: the gate adds it after the model, so this is matched on the
     * executed call, and a call that did not run never matches.
     */
    approvedValue: Type.Optional(
      Type.Object(
        { name: Type.String({ minLength: 1 }), cents: Type.Integer() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * A scenario's answer to one approval: `approve`, `decline`, `pending`, or a yes with the value the
 * person enters, for an approval that declares one. `validateSuite` checks the value
 * against the manifest; the gate checks it against the bounds when the trial runs.
 */
const ScriptedApproval = Type.Union(
  [
    Type.Enum(["approve", "decline", "pending"]),
    Type.Object(
      { decision: Type.Enum(["approve", "decline"]), valueCents: Type.Number() },
      { additionalProperties: false },
    ),
  ],
  {
    "x-hint":
      'must be "approve", "decline", "pending", or { "decision": "approve", "valueCents": <whole cents> } for an approval that asks for a value',
  },
);
export type ScriptedApproval = Static<typeof ScriptedApproval>;

/** A scripted answer in one shape: the decision, and the value it carries, if any. */
export function scriptedDecision(answer: ScriptedApproval): {
  readonly decision: "approve" | "decline" | "pending";
  readonly valueCents?: number;
} {
  return typeof answer === "string" ? { decision: answer } : answer;
}

/**
 * The statuses a ticket on a host's board can be in (the board's own list, which the SDK cannot
 * import).
 */
const TICKET_STATUSES = [
  "open",
  "claimed",
  "waiting",
  "awaiting_confirmation",
  "blocked",
  "done",
  "cancelled",
] as const;

/**
 * What the board must hold for the trial's own ticket when the trial ends; office mode
 * only. `refusedWith` names checks as the manifest declares them (an engine subcommand joined by
 * spaces, a tool's or a file's name): the board must have refused a reply for each, and the agent
 * must have read the board's line saying why.
 */
const TicketExpect = Type.Object(
  {
    status: Type.Enum([...TICKET_STATUSES]),
    refusedWith: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);
export type TicketExpectation = Static<typeof TicketExpect>;

const Expect = Type.Object(
  {
    ticket: Type.Optional(TicketExpect),
    calls: Type.Optional(Type.Array(ExpectedCall)),
    notCalled: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    approvalsRequested: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    delegated: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /**
     * Tickets the trial's work dispatched (children of the trial's ticket), office mode only
     *: each matcher must match one, with the `argsMatch` rules, over `type`, `status`,
     * `subjects` and the rest of the trace's ticket summary.
     */
    dispatched: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    /** No ticket the trial's work dispatched may match any of these; office mode only. */
    notDispatched: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    reply: Type.Optional(
      Type.Object(
        {
          contains: Type.Optional(Words),
          // Each entry is a group of alternatives: the reply must carry at least one phrase from
          // every group, so a scenario names the facts it needs rather than one sentence.
          containsAny: Type.Optional(Type.Array(Words, { minItems: 1 })),
          // Each phrase must be in an accepted shape; see reply-assertions.ts.
          notContains: Type.Optional(Type.Array(NotContainsEntry)),
          // What the reply claims, graded by a judge model in a live run; see judge.ts.
          judged: Type.Optional(Type.Array(JudgedAssertion)),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * A record written straight into memory's storage before the turn, as earlier work (or an attacker
 * with access to the store) would have left it: it never passes through `memory_save` or its guards.
 * The runner sets its scope, author and date.
 */
const MemorySeed = Type.Object(
  {
    id: Type.String({
      pattern: "^mem_[0-9A-Z]{26}$",
      "x-hint": 'mem_ and 26 capital letters or digits, like "mem_SEEDACMEAPCONTACT000000000"',
    }),
    about: Type.String({
      pattern: SUBJECT_PATTERN,
      "x-hint": "a subject, like customer:quickbooks:42",
    }),
    kind: Type.Enum([...KINDS]),
    category: Type.Enum([...CATEGORIES]),
    text: Type.String({ minLength: 1 }),
    /** Omitted: `active`. */
    status: Type.Optional(Type.Enum([...STATUSES])),
    reviewAt: Type.Optional(
      Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", "x-hint": "YYYY-MM-DD" }),
    ),
    /** Omitted: a person, `{ "type": "person", "ref": "seed" }`. */
    source: Type.Optional(
      Type.Object(
        { type: Type.Enum([...SOURCE_TYPES]), ref: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** A partial match on a stored record or review item, with the `argsMatch` rules. */
const MemoryMatcher = Type.Record(Type.String(), Type.Unknown());

/**
 * What memory must hold once the trial ends, and what the model must or must not have read from it.
 * `prompted` and `unread` quote seeded text only, so a match proves memory carried it.
 */
const MemoryExpect = Type.Object(
  {
    /** How many records are stored, seeded ones and superseded ones included. */
    count: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Each must match a stored record, whatever its status. */
    records: Type.Optional(Type.Array(MemoryMatcher)),
    /** No stored record may match any of these. */
    absent: Type.Optional(Type.Array(MemoryMatcher)),
    /** Each must match an item of the office's memory review queue; office mode only. */
    reviews: Type.Optional(Type.Array(MemoryMatcher)),
    /** Seeded text that must be in a prompt the model was given (the `memory` section). */
    prompted: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    /** Seeded text the model must never read, in a prompt or a tool result. */
    unread: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

/**
 * A scenario that runs its role with memory: the memory extension beside the role in bare mode, the
 * office's memory in office mode. `seed` plants records first; `expect` checks memory afterwards.
 */
export const MemoryBlockSchema = Type.Object(
  {
    seed: Type.Optional(Type.Array(MemorySeed)),
    expect: Type.Optional(MemoryExpect),
  },
  { additionalProperties: false },
);
export type MemoryBlock = Static<typeof MemoryBlockSchema>;
export type MemorySeedRecord = Static<typeof MemorySeed>;
export type MemoryExpectation = Static<typeof MemoryExpect>;

export const ScenarioSchema = Type.Object(
  {
    id: Id,
    description: Type.String({ minLength: 1, maxLength: 300 }),
    severity: Type.Optional(Type.Enum(["critical", "normal"])),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    // Only the kind is checked here; validateSuite then checks the shape that kind requires, which
    // gives one clear message instead of one per possible shape.
    input: Type.Object({ kind: Type.Enum(["message", "ticket"]) }),
    // Optional only when the file declares top-level stubs; validateSuite checks that.
    stubs: Type.Optional(Stubs),
    // `pending`: the request reaches a person who never answers during the trial, so the call stays
    // unrun and the run goes on — how a scenario tests what the role says while it waits.
    approvals: Type.Optional(Type.Record(Type.String(), ScriptedApproval)),
    // The office's person confirms the trial's ticket once the run ends, as they would in the Inbox;
    // the trial fails if the ticket is not then waiting for them. Office mode only.
    confirmation: Type.Optional(Type.Literal("confirm")),
    memory: Type.Optional(MemoryBlockSchema),
    expect: Expect,
    trials: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    limits: Type.Optional(
      Type.Object(
        {
          maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * The harness a suite needs: `office`, so a bare run skips it, or `bare`, so an office run skips it;
 * either run says so. `bare` is for a scenario whose right answer depends on there being no office:
 * with no `agent_dispatch`, a role says nothing was handed on, where in an office it hands it on.
 */
const SuiteMode = Type.Enum(["office", "bare"], { "x-hint": 'must be "office" or "bare"' });
/**
 * The model a suite needs: `scripted`, for scenarios whose model is scripted to misbehave (to claim a
 * ticket is done before the work, say). A live model cannot be told to, so a live run skips them.
 */
const SuiteModel = Type.Literal("scripted");
/**
 * The tool packs a suite runs the role with, by id: a run that does not give the role
 * every one of them skips it. Its scenarios stub and may expect those packs' tools.
 */
const SuitePacks = Type.Array(
  Type.String({ pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", "x-hint": 'a pack id, like "data"' }),
  { minItems: 1, uniqueItems: true },
);

export const SuiteSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    mode: Type.Optional(SuiteMode),
    model: Type.Optional(SuiteModel),
    packs: Type.Optional(SuitePacks),
    // Stubs every scenario gets unless it stubs that tool itself, so read data is written once.
    stubs: Type.Optional(Stubs),
    scenarios: Type.Array(ScenarioSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const InputSchemas = { message: MessageInput, ticket: TicketInput } as const;

export type ScenarioInput = Static<typeof MessageInput> | Static<typeof TicketInput>;
/** A validated scenario: its stubs already carry the file's shared stubs, so runners read one place. */
export type Scenario = Omit<Static<typeof ScenarioSchema>, "input" | "stubs"> & {
  readonly input: ScenarioInput;
  readonly stubs: Static<typeof Stubs>;
};
export type EvalSuite = {
  readonly $schema?: string;
  /**
   * `office` when only an office-mode run may run the suite (a bare run skips it); `bare` when only a
   * bare run may (an office-mode run skips it). Omitted: both run it.
   */
  readonly mode?: "office" | "bare";
  /** Set when only a scripted model may run the suite; a live run skips it. */
  readonly model?: "scripted";
  /** The tool packs the suite runs the role with; a run that does not give them skips it. */
  readonly packs?: readonly string[];
  readonly scenarios: readonly Scenario[];
};
/** A scenario as the file writes it, before the file's shared stubs are folded in. */
type ScenarioFile = Omit<Static<typeof ScenarioSchema>, "input"> & {
  readonly input: ScenarioInput;
};
type SuiteFile = Omit<Static<typeof SuiteSchema>, "scenarios"> & {
  readonly scenarios: readonly ScenarioFile[];
};
export type Stub = Static<typeof Stub>;
export type ScenarioExpect = Scenario["expect"];

/**
 * Validates one eval file against the schema and against the role's manifest: stubs, expected
 * calls and approvals must name what the manifest declares, and a ticket input must be a type the
 * role accepts. Every declared tool must be stubbed, by the scenario or by the file's top-level
 * `stubs`, so an eval can never reach a real system. The suite it returns is resolved: each
 * scenario's `stubs` already holds the file's stubs for every tool it does not stub itself, so
 * runners need no merging of their own.
 */
export function validateSuite(
  value: unknown,
  manifest: AgentManifest,
  source: string,
): Validation<EvalSuite> {
  const issues = schemaIssues(SuiteSchema, value, source);
  if (issues.length > 0) return { ok: false, issues };
  (value as { scenarios: { input: { kind: "message" | "ticket" } }[] }).scenarios.forEach(
    (scenario, index) => {
      const kind = scenario.input.kind;
      for (const issue of schemaIssues(InputSchemas[kind], scenario.input, source)) {
        issues.push({
          ...issue,
          path: joinPath(joinPath(joinPath("scenarios", index), "input"), issue.path),
        });
      }
    },
  );
  if (issues.length > 0) return { ok: false, issues };

  const file = value as SuiteFile;
  const crossIssues: Issue[] = [];
  const add = (path: string, message: string) => crossIssues.push({ source, path, message });
  const manifestTools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const tools = new Set(manifestTools.keys());
  const approvals = new Set(manifest.approvals.map((approval) => approval.id));
  const accepts = new Set(manifest.accepts.map((accept) => accept.type));
  const seen = new Set<string>();
  // A pack tool is offered only in a run that gives the role its pack: this suite runs
  // with the packs it declares, so it stubs and may expect their tools, and no other pack's.
  const rolePacks = declaredPacks(manifest);
  const suitePacks = new Set(file.packs ?? []);
  (file.packs ?? []).forEach((pack, index) => {
    if (!rolePacks.includes(pack)) {
      add(
        `packs[${index}]`,
        `${show(pack)} is not a pack any of the role's tools comes from (it declares ${
          rolePacks.length === 0 ? "no pack tools" : `tools from ${rolePacks.map(show).join(", ")}`
        })`,
      );
    }
  });
  const packOf = (tool: string) => manifestTools.get(tool)?.pack;
  const offered = (tool: string) => {
    const pack = packOf(tool);
    return pack === undefined || suitePacks.has(pack);
  };

  /** Checks one stubs record, at `stubs` under `base`: the file's own, or a scenario's. */
  const checkStubs = (stubs: Static<typeof Stubs>, base: string) => {
    const at = (field: string) => joinPath(base, field);
    for (const tool of Object.keys(stubs)) {
      if (!tools.has(tool)) add(at(`stubs.${tool}`), "is not a declared tool");
    }
    for (const [tool, stub] of Object.entries(stubs)) {
      if (!("byArgs" in stub)) continue;
      stub.byArgs.forEach((entry, entryIndex) => {
        matcherIssues(entry.args, at(`stubs.${tool}.byArgs[${entryIndex}].args`), add);
      });
      // Only engine tools name their parameters in the manifest; a tool defined in code has none to check.
      const parameters = manifestTools.get(tool)?.parameters;
      if (parameters === undefined) continue;
      stub.byArgs.forEach((entry, entryIndex) => {
        for (const name of Object.keys(entry.args)) {
          if (!(name in parameters))
            add(
              at(`stubs.${tool}.byArgs[${entryIndex}].args.${name}`),
              `is not a parameter of ${show(tool)}`,
            );
        }
      });
    }
  };

  if (file.stubs !== undefined) checkStubs(file.stubs, "");

  file.scenarios.forEach((scenario, index) => {
    const at = (field: string) => joinPath(joinPath("scenarios", index), field);
    if (seen.has(scenario.id)) add(at("id"), `${show(scenario.id)} is used by another scenario`);
    seen.add(scenario.id);

    if (scenario.input.kind === "message" && scenario.input.origin !== undefined) {
      if (scenario.input.from === undefined) {
        add(
          at("input.origin"),
          "says where the sender wrote from, but the scenario names no sender: add input.from, or remove origin",
        );
      }
    }
    if (scenario.stubs === undefined && file.stubs === undefined) {
      add(at("stubs"), "is required: this file declares no top-level stubs for it to use");
    }
    if (scenario.stubs !== undefined) checkStubs(scenario.stubs, joinPath("scenarios", index));
    const stubbed = resolvedStubs(file.stubs, scenario.stubs);
    for (const tool of manifest.tools) {
      if (offered(tool.name) && !(tool.name in stubbed)) {
        add(
          at("stubs"),
          `must stub ${show(tool.name)} here or in the file's top-level stubs; evals never call real tools`,
        );
      }
    }
    for (const [id, answer] of Object.entries(scenario.approvals ?? {})) {
      const declared = manifest.approvals.find((approval) => approval.id === id);
      if (declared === undefined) {
        add(at(`approvals.${id}`), "is not a declared approval");
        continue;
      }
      scriptedValueIssues(answer, declared, at(`approvals.${id}`), add);
    }
    if (scenario.input.kind === "ticket" && !accepts.has(scenario.input.type)) {
      add(at("input.type"), `${show(scenario.input.type)} is not a ticket type this role accepts`);
    }

    const { expect } = scenario;
    // Only an office-mode run has a board; a bare run would grade these against nothing.
    if (file.mode !== "office") {
      const declare = 'declare "mode": "office" at the top of the file';
      if (scenario.confirmation !== undefined) {
        add(at("confirmation"), `only an office-mode suite has a board to confirm on; ${declare}`);
      }
      if (expect.ticket !== undefined) {
        add(
          at("expect.ticket"),
          `only an office-mode suite has a board ticket to check; ${declare}`,
        );
      }
      for (const field of ["dispatched", "notDispatched"] as const) {
        if (expect[field] !== undefined) {
          add(
            at(`expect.${field}`),
            `only an office-mode suite has a board to dispatch on; ${declare}`,
          );
        }
      }
    }
    for (const field of ["dispatched", "notDispatched"] as const) {
      expect[field]?.forEach((matcher, matcherIndex) => {
        matcherIssues(matcher, at(`expect.${field}[${matcherIndex}]`), add);
      });
    }
    // A scenario with memory runs the memory tools for real, so it may expect them as well; so does
    // an office-mode suite the office's communication tools, which only an office has.
    const expectable = (tool: string) =>
      tools.has(tool) ||
      (scenario.memory !== undefined && (MEMORY_TOOL_NAMES as readonly string[]).includes(tool)) ||
      (file.mode === "office" && (COMMUNICATION_TOOL_NAMES as readonly string[]).includes(tool));
    expect.calls?.forEach((call, callIndex) => {
      if (call.args !== undefined)
        matcherIssues(call.args, at(`expect.calls[${callIndex}].args`), add);
      if (!expectable(call.tool))
        add(at(`expect.calls[${callIndex}].tool`), `${show(call.tool)} is not a declared tool`);
      else if (!offered(call.tool)) {
        const pack = packOf(call.tool) ?? "";
        add(
          at(`expect.calls[${callIndex}].tool`),
          `${show(call.tool)} comes from the ${pack} pack, which this suite does not run with; declare "packs": [${show(pack)}] at the top of the file`,
        );
      }
      const valueName = call.approvedValue?.name;
      if (
        valueName !== undefined &&
        !manifest.approvals.some(
          (approval) => approval.tool === call.tool && approval.value?.name === valueName,
        )
      ) {
        add(
          at(`expect.calls[${callIndex}].approvedValue.name`),
          `${show(valueName)} is not a value an approval of ${show(call.tool)} asks for`,
        );
      }
    });
    expect.notCalled?.forEach((tool, toolIndex) => {
      if (!expectable(tool))
        add(at(`expect.notCalled[${toolIndex}]`), `${show(tool)} is not a declared tool`);
    });
    if (scenario.memory !== undefined) {
      memoryIssues(
        scenario.memory,
        {
          input:
            scenario.input.kind === "message"
              ? scenario.input.text
              : JSON.stringify(scenario.input.payload),
          stubs: Object.values(stubbed).flatMap(stubTexts),
        },
        at("memory"),
        add,
      );
    }
    expect.approvalsRequested?.forEach((id, idIndex) => {
      if (!approvals.has(id))
        add(at(`expect.approvalsRequested[${idIndex}]`), `${show(id)} is not a declared approval`);
    });

    // A phrase with a stated reason is the author's own call; every bare phrase needs a shape.
    const context = {
      input:
        scenario.input.kind === "message"
          ? scenario.input.text
          : JSON.stringify(scenario.input.payload),
      forbiddenReceipts: forbiddenReceipts(scenario, stubbed, manifest),
    };
    expect.reply?.notContains?.forEach((entry, entryIndex) => {
      if (typeof entry !== "string") return;
      if (notContainsShape(entry, context) === undefined)
        add(
          at(`expect.reply.notContains[${entryIndex}]`),
          `${show(entry)}: ${NOT_CONTAINS_ADVICE}`,
        );
    });
    judgedIssues(expect.reply?.judged ?? [], at("expect.reply.judged"), add);
  });

  if (crossIssues.length > 0) return { ok: false, issues: crossIssues };
  // Resolved here, once, so every runner reads complete per-scenario stubs and none merges its own.
  const { stubs: shared, scenarios, ...rest } = file;
  const suite: EvalSuite = {
    ...rest,
    scenarios: scenarios.map((scenario) => ({
      ...scenario,
      stubs: resolvedStubs(shared, scenario.stubs),
    })),
  };
  return { ok: true, value: suite, issues: [] };
}

/**
 * Checks a scenario's judged claims, each problem with its path under `base`: an empty or blank
 * claim, one over `MAX_CLAIM_LENGTH`, a question rather than a statement, and a claim the scenario
 * already judges (compared ignoring case and surrounding space).
 */
function judgedIssues(
  judged: readonly Static<typeof JudgedAssertion>[],
  base: string,
  add: (path: string, message: string) => void,
): void {
  const seen = new Map<string, number>();
  judged.forEach(({ claim }, index) => {
    const at = joinPath(joinPath(base, `[${index}]`), "claim");
    const text = claim.trim();
    if (text === "") {
      add(at, "is empty; write the claim as a sentence about the reply");
      return;
    }
    if (claim.length > MAX_CLAIM_LENGTH) {
      add(at, `is ${claim.length} characters; keep a claim to ${MAX_CLAIM_LENGTH} or fewer`);
    }
    if (text.endsWith("?")) {
      add(
        at,
        'ends with a question mark; state the claim as a sentence ("The reply promises …"), not a question',
      );
    }
    const key = text.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      add(at, `repeats judged[${first}]'s claim; a scenario judges each claim once`);
    } else {
      seen.set(key, index);
    }
  });
}

/**
 * Result texts of the stubs for tools this scenario keeps from running: those it lists in
 * `notCalled`, and those whose approval it scripts as declined or pending. Only these may supply a
 * `notContains` receipt token, since a reply can carry their text only by relaying a result that
 * never happened.
 */
function forbiddenReceipts(
  scenario: ScenarioFile,
  stubs: Static<typeof Stubs>,
  manifest: AgentManifest,
): string[] {
  const forbidden = new Set(scenario.expect.notCalled ?? []);
  for (const [id, answer] of Object.entries(scenario.approvals ?? {})) {
    if (scriptedDecision(answer).decision === "approve") continue;
    const tool = manifest.approvals.find((approval) => approval.id === id)?.tool;
    if (tool !== undefined) forbidden.add(tool);
  }
  return [...forbidden].flatMap((tool) => {
    const stub = stubs[tool];
    return stub === undefined ? [] : stubTexts(stub);
  });
}

/**
 * Checks a scripted answer against the approval it answers, at `path`: a decline carries no value, a
 * value is whole cents, an approval that asks for no value gets none, and one that asks for a value
 * gets one with a yes. Bounds are the gate's to check when the trial runs, so a scenario can script a
 * value out of bounds and see it refused.
 */
function scriptedValueIssues(
  answer: ScriptedApproval,
  approval: ApprovalDeclaration,
  path: string,
  add: (path: string, message: string) => void,
): void {
  const { decision, valueCents } = scriptedDecision(answer);
  const valuePath = joinPath(path, "valueCents");
  if (valueCents === undefined) {
    if (decision === "approve" && approval.value !== undefined) {
      add(
        path,
        `the ${approval.id} approval asks for ${show(approval.value.label)} (${approval.value.name}); script it as { "decision": "approve", "valueCents": … }`,
      );
    }
    return;
  }
  if (decision !== "approve") {
    add(valuePath, 'a decline carries no value; script it as "decline"');
  } else if (approval.value === undefined) {
    add(valuePath, `the ${approval.id} approval asks for no value; script it as "approve"`);
  } else if (!Number.isSafeInteger(valueCents)) {
    add(valuePath, `must be a whole number of cents (got ${show(valueCents)})`);
  }
}

/** Every text a stub can answer with. */
function stubTexts(stub: Static<typeof Stub>): string[] {
  if (!("byArgs" in stub)) return [stub.text];
  return [
    ...stub.byArgs.map((entry) => entry.text),
    ...(stub.otherwise ? [stub.otherwise.text] : []),
  ];
}

/** What else carries text to the model besides memory: the scenario's input and its stubs. */
export interface MemoryWritten {
  readonly input: string;
  readonly stubs: readonly string[];
}

/**
 * Checks a memory block beyond its schema, each problem with its path under `base`: a seeded id used
 * twice; a `prompted` or `unread` phrase that no seeded record carries, or that the input or a stub
 * also carries (finding it would prove nothing about memory); and malformed matchers. The red-team
 * loader checks its scenarios' memory blocks with this too.
 */
export function memoryIssues(
  memory: MemoryBlock,
  written: MemoryWritten,
  base: string,
  add: (path: string, message: string) => void,
): void {
  const at = (field: string) => joinPath(base, field);
  const ids = new Set<string>();
  memory.seed?.forEach((record, index) => {
    if (ids.has(record.id))
      add(at(`seed[${index}].id`), `${show(record.id)} is used by another seeded record`);
    ids.add(record.id);
  });
  const seeded = (memory.seed ?? []).map((record) => record.text);
  const elsewhere = [written.input, ...written.stubs];
  for (const field of ["prompted", "unread"] as const) {
    memory.expect?.[field]?.forEach((phrase, index) => {
      if (!seeded.some((text) => text.includes(phrase))) {
        add(
          at(`expect.${field}[${index}]`),
          `${show(phrase)} is in no seeded record, so finding it proves nothing about memory: quote a seeded record's text`,
        );
      } else if (elsewhere.some((text) => text.includes(phrase))) {
        add(
          at(`expect.${field}[${index}]`),
          `${show(phrase)} is also in the input or a stub, so finding it proves nothing about memory: quote text only a seeded record carries`,
        );
      }
    });
  }
  for (const field of ["records", "absent", "reviews"] as const) {
    memory.expect?.[field]?.forEach((matcher, index) => {
      matcherIssues(matcher, at(`expect.${field}[${index}]`), add);
    });
  }
}

/** A scenario's stub for a tool replaces the file's stub for that tool whole; the rest come from the file. */
function resolvedStubs(
  shared: Static<typeof Stubs> | undefined,
  own: Static<typeof Stubs> | undefined,
): Static<typeof Stubs> {
  return { ...shared, ...own };
}

/**
 * Every `{ "includes": … }` in `args` must be exactly one non-empty string, and every `{ "some": … }`
 * exactly one object of fields (checked the same way inside), each reported with its path.
 * A matcher is an argument's value, never `args` itself: at the top level `includes` would read as a
 * parameter of that name, which no matcher can then express, so it is refused.
 */
function matcherIssues(
  args: unknown,
  path: string,
  add: (path: string, message: string) => void,
  top = true,
): void {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return;
  if (top && "includes" in args) {
    add(
      joinPath(path, "includes"),
      'an includes matcher goes on an argument\'s value, e.g. { "sku": { "includes": "…" } }, never on args itself',
    );
  }
  if (top && "some" in args) {
    add(
      joinPath(path, "some"),
      'a some matcher goes on an array argument\'s value, e.g. { "lines": { "some": { "sku": "…" } } }, never on args itself',
    );
  }
  for (const [key, value] of Object.entries(args)) {
    const at = joinPath(path, key);
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    if ("includes" in value) {
      const { includes, ...rest } = value as { includes: unknown };
      if (typeof includes !== "string" || includes === "") {
        add(
          joinPath(at, "includes"),
          'must be a non-empty string: { "includes": "…" } matches a string argument that contains it',
        );
      } else if (Object.keys(rest).length > 0) {
        add(
          at,
          `an includes matcher takes no other fields; remove ${Object.keys(rest)
            .map((name) => show(name))
            .join(", ")}`,
        );
      }
      continue;
    }
    if ("some" in value) {
      const { some, ...rest } = value as { some: unknown };
      if (some === null || typeof some !== "object" || Array.isArray(some)) {
        add(
          joinPath(at, "some"),
          'must be an object of fields: { "some": { … } } matches an array argument with an element that has them',
        );
      } else if (Object.keys(rest).length > 0) {
        add(
          at,
          `a some matcher takes no other fields; remove ${Object.keys(rest)
            .map((name) => show(name))
            .join(", ")}`,
        );
      } else {
        matcherIssues(some, joinPath(at, "some"), add, false);
      }
      continue;
    }
    matcherIssues(value, at, add, false);
  }
}
