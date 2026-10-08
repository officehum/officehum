/**
 * The eval file format: scenarios with expected outcomes, checked against the role's manifest.
 * See "Evals" in docs/design/agent-package.md.
 */

import { type Static, Type } from "typebox";
import { type Issue, joinPath, schemaIssues, show, type Validation } from "../issues.js";
import type { AgentManifest } from "../manifest.js";

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

const MessageInput = Type.Object(
  {
    kind: Type.Literal("message"),
    text: Type.String({ minLength: 1 }),
    channel: Type.Optional(Type.Enum(["email", "sms", "chat"])),
    from: Type.Optional(Type.String({ minLength: 1 })),
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
const Stub = Type.Object(
  { text: Type.String(), isError: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

const ExpectedCall = Type.Object(
  {
    tool: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const Expect = Type.Object(
  {
    calls: Type.Optional(Type.Array(ExpectedCall)),
    notCalled: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    approvalsRequested: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    delegated: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    reply: Type.Optional(
      Type.Object(
        { contains: Type.Optional(Words), notContains: Type.Optional(Words) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ScenarioSchema = Type.Object(
  {
    id: Id,
    description: Type.String({ minLength: 1, maxLength: 300 }),
    severity: Type.Optional(Type.Enum(["critical", "normal"])),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    // Only the kind is checked here; validateSuite then checks the shape that kind requires, which
    // gives one clear message instead of one per possible shape.
    input: Type.Object({ kind: Type.Enum(["message", "ticket"]) }),
    stubs: Type.Record(Type.String(), Stub),
    approvals: Type.Optional(Type.Record(Type.String(), Type.Enum(["approve", "decline"]))),
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

export const SuiteSchema = Type.Object(
  { $schema: Type.Optional(Type.String()), scenarios: Type.Array(ScenarioSchema, { minItems: 1 }) },
  { additionalProperties: false },
);

const InputSchemas = { message: MessageInput, ticket: TicketInput } as const;

export type ScenarioInput = Static<typeof MessageInput> | Static<typeof TicketInput>;
export type Scenario = Omit<Static<typeof ScenarioSchema>, "input"> & {
  readonly input: ScenarioInput;
};
export type EvalSuite = { readonly $schema?: string; readonly scenarios: readonly Scenario[] };
export type ScenarioExpect = Scenario["expect"];

/**
 * Validates one eval file against the schema and against the role's manifest: stubs, expected
 * calls and approvals must name what the manifest declares, and a ticket input must be a type the
 * role accepts. Every declared tool must be stubbed, so an eval can never reach a real system.
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

  const suite = value as EvalSuite;
  const crossIssues: Issue[] = [];
  const add = (path: string, message: string) => crossIssues.push({ source, path, message });
  const tools = new Set(manifest.tools.map((tool) => tool.name));
  const approvals = new Set(manifest.approvals.map((approval) => approval.id));
  const accepts = new Set(manifest.accepts.map((accept) => accept.type));
  const seen = new Set<string>();

  suite.scenarios.forEach((scenario, index) => {
    const at = (field: string) => joinPath(joinPath("scenarios", index), field);
    if (seen.has(scenario.id)) add(at("id"), `${show(scenario.id)} is used by another scenario`);
    seen.add(scenario.id);

    for (const tool of Object.keys(scenario.stubs)) {
      if (!tools.has(tool)) add(at(`stubs.${tool}`), "is not a declared tool");
    }
    for (const tool of manifest.tools) {
      if (!(tool.name in scenario.stubs)) {
        add(at("stubs"), `must stub ${show(tool.name)}; evals never call real tools`);
      }
    }
    for (const id of Object.keys(scenario.approvals ?? {})) {
      if (!approvals.has(id)) add(at(`approvals.${id}`), "is not a declared approval");
    }
    if (scenario.input.kind === "ticket" && !accepts.has(scenario.input.type)) {
      add(at("input.type"), `${show(scenario.input.type)} is not a ticket type this role accepts`);
    }

    const { expect } = scenario;
    expect.calls?.forEach((call, callIndex) => {
      if (!tools.has(call.tool))
        add(at(`expect.calls[${callIndex}].tool`), `${show(call.tool)} is not a declared tool`);
    });
    expect.notCalled?.forEach((tool, toolIndex) => {
      if (!tools.has(tool))
        add(at(`expect.notCalled[${toolIndex}]`), `${show(tool)} is not a declared tool`);
    });
    expect.approvalsRequested?.forEach((id, idIndex) => {
      if (!approvals.has(id))
        add(at(`expect.approvalsRequested[${idIndex}]`), `${show(id)} is not a declared approval`);
    });
  });

  return crossIssues.length > 0
    ? { ok: false, issues: crossIssues }
    : { ok: true, value: suite, issues: [] };
}
