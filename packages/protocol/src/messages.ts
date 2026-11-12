/**
 * Gateway Protocol v1 messages: schemas, types and the validator. `docs/design/gateway-protocol.md`
 * is the prose reference; keep the two in step.
 */

import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const PROTOCOL_VERSION = 1;

export const ERROR_CODES = [
  "bad_frame",
  "frame_too_large",
  "unsupported_version",
  "invalid_message",
  "unknown_agent",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "busy",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The longest an id may be: message, request, principal and approval ids alike. */
const ID_MAX_LENGTH = 256;
const Id = Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH });
const Name = Type.String({ minLength: 1 });
const Decision = Type.Enum(["approve", "decline"]);

/**
 * Who a command acts for. Only the gateway adds it, from the authenticated session, to commands it
 * forwards to the runtime; a client may never send it.
 */
export const PrincipalSchema = Type.Object(
  {
    id: Id,
    roles: Type.Array(Name),
    approvalLimit: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type Principal = Static<typeof PrincipalSchema>;

// Handshake

export const HelloSchema = Type.Object(
  // Any version parses, so a client asking for one this server does not speak is told
  // `unsupported_version` by `handshake` rather than `invalid_message`.
  {
    type: Type.Literal("hello"),
    version: Type.Unknown(),
    client: Name,
    // A WebSocket client that cannot set an `Authorization` header (a browser) signs in with its
    // bearer token here, in its first frame. The gateway reads it and never forwards it.
    token: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type Hello = Static<typeof HelloSchema>;

export const WelcomeSchema = Type.Object(
  { type: Type.Literal("welcome"), version: Type.Literal(PROTOCOL_VERSION), serverId: Id },
  { additionalProperties: false },
);
export type Welcome = Static<typeof WelcomeSchema>;

// Client commands

const MessageInputSchema = Type.Object(
  { kind: Type.Literal("message"), text: Name },
  { additionalProperties: false },
);
const TicketInputSchema = Type.Object(
  { kind: Type.Literal("ticket"), type: Name, payload: Type.Unknown() },
  { additionalProperties: false },
);
export type SubmitInput = Static<typeof MessageInputSchema> | Static<typeof TicketInputSchema>;

export const SubmitSchema = Type.Object(
  {
    type: Type.Literal("submit"),
    id: Id,
    agent: Id,
    requestId: Id,
    input: Type.Union([MessageInputSchema, TicketInputSchema]),
    conversation: Type.Optional(Id),
    principal: Type.Optional(PrincipalSchema),
  },
  { additionalProperties: false },
);
export const SubscribeSchema = Type.Object(
  {
    type: Type.Literal("subscribe"),
    id: Id,
    requestId: Id,
    afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    principal: Type.Optional(PrincipalSchema),
  },
  { additionalProperties: false },
);
export const GetStateSchema = Type.Object(
  {
    type: Type.Literal("get_state"),
    id: Id,
    agent: Type.Optional(Id),
    principal: Type.Optional(PrincipalSchema),
  },
  { additionalProperties: false },
);
export const ListAgentsSchema = Type.Object(
  { type: Type.Literal("list_agents"), id: Id, principal: Type.Optional(PrincipalSchema) },
  { additionalProperties: false },
);
export const AbortSchema = Type.Object(
  {
    type: Type.Literal("abort"),
    id: Id,
    requestId: Id,
    principal: Type.Optional(PrincipalSchema),
  },
  { additionalProperties: false },
);
export const ApproveSchema = Type.Object(
  {
    type: Type.Literal("approve"),
    id: Id,
    approvalId: Id,
    decision: Decision,
    note: Type.Optional(Type.String()),
    principal: Type.Optional(PrincipalSchema),
  },
  { additionalProperties: false },
);
/**
 * Asks for the approvals the caller may decide: the reply's `data.approvals` lists those waiting, and
 * the connection then receives an `approval` message each time one is asked for or decided.
 */
export const WatchApprovalsSchema = Type.Object(
  { type: Type.Literal("watch_approvals"), id: Id, principal: Type.Optional(PrincipalSchema) },
  { additionalProperties: false },
);
export const PingSchema = Type.Object(
  { type: Type.Literal("ping"), id: Id, principal: Type.Optional(PrincipalSchema) },
  { additionalProperties: false },
);

type WithoutPrincipal<T> = T extends unknown ? Omit<T, "principal"> : never;
type Command =
  | Static<typeof SubmitSchema>
  | Static<typeof SubscribeSchema>
  | Static<typeof GetStateSchema>
  | Static<typeof ListAgentsSchema>
  | Static<typeof AbortSchema>
  | Static<typeof ApproveSchema>
  | Static<typeof WatchApprovalsSchema>
  | Static<typeof PingSchema>;

/** A command as a client sends it: never with a principal. */
export type ClientCommand = WithoutPrincipal<Command>;
/** A command as the gateway forwards it to the runtime: always with a principal. */
export type ForwardedCommand = WithoutPrincipal<Command> & { readonly principal: Principal };
export type Submit = Extract<ClientCommand, { type: "submit" }>;
export type Subscribe = Extract<ClientCommand, { type: "subscribe" }>;
export type GetState = Extract<ClientCommand, { type: "get_state" }>;
export type ListAgents = Extract<ClientCommand, { type: "list_agents" }>;
export type Abort = Extract<ClientCommand, { type: "abort" }>;
export type Approve = Extract<ClientCommand, { type: "approve" }>;
export type WatchApprovals = Extract<ClientCommand, { type: "watch_approvals" }>;
export type Ping = Extract<ClientCommand, { type: "ping" }>;

// Replies

export const AcceptedSchema = Type.Object(
  {
    type: Type.Literal("accepted"),
    id: Id,
    requestId: Id,
    disposition: Type.Enum(["started", "queued", "existing"]),
  },
  { additionalProperties: false },
);
export type Accepted = Static<typeof AcceptedSchema>;

export const ResultSchema = Type.Object(
  {
    type: Type.Literal("result"),
    id: Id,
    ok: Type.Literal(true),
    // The body of a command's answer; its shape belongs to the command (see the protocol doc).
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type Result = Static<typeof ResultSchema>;

const ProblemSchema = Type.Object(
  { path: Type.String(), message: Type.String() },
  { additionalProperties: false },
);
/** One thing wrong with a message: where (`input.text`, empty for the whole message) and what. */
export type Problem = Static<typeof ProblemSchema>;

export const ErrorSchema = Type.Object(
  {
    type: Type.Literal("error"),
    id: Type.Optional(Id),
    code: Type.Enum([...ERROR_CODES]),
    message: Type.String(),
    problems: Type.Optional(Type.Array(ProblemSchema)),
  },
  { additionalProperties: false },
);
export type ErrorMessage = Static<typeof ErrorSchema>;

// Events

const EVENT_SCHEMAS = {
  text_delta: Type.Object(
    { kind: Type.Literal("text_delta"), text: Type.String() },
    { additionalProperties: false },
  ),
  tool_start: Type.Object(
    { kind: Type.Literal("tool_start"), toolCallId: Id, tool: Name },
    { additionalProperties: false },
  ),
  tool_end: Type.Object(
    { kind: Type.Literal("tool_end"), toolCallId: Id, tool: Name, ok: Type.Boolean() },
    { additionalProperties: false },
  ),
  approval_requested: Type.Object(
    {
      kind: Type.Literal("approval_requested"),
      approvalId: Id,
      tool: Name,
      summary: Type.String(),
      // The agent waiting, and when the request times out (declined), as an ISO 8601 time.
      agent: Type.Optional(Name),
      expiresAt: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  approval_decided: Type.Object(
    {
      kind: Type.Literal("approval_decided"),
      approvalId: Id,
      decision: Decision,
      // The approving principal; absent when the gate decided on its own (a timeout declines).
      by: Type.Optional(Id),
    },
    { additionalProperties: false },
  ),
  settled: Type.Object(
    {
      kind: Type.Literal("settled"),
      status: Type.Enum(["done", "failed", "aborted"]),
      answer: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
} as const;
export type EventKind = keyof typeof EVENT_SCHEMAS;
export type RequestEvent = Static<(typeof EVENT_SCHEMAS)[EventKind]>;

export const EventSchema = Type.Object(
  {
    type: Type.Literal("event"),
    requestId: Id,
    seq: Type.Integer({ minimum: 1 }),
    // Listed out: `Object.values` would lose the tuple type and make `event` typed `never`.
    event: Type.Union([
      EVENT_SCHEMAS.text_delta,
      EVENT_SCHEMAS.tool_start,
      EVENT_SCHEMAS.tool_end,
      EVENT_SCHEMAS.approval_requested,
      EVENT_SCHEMAS.approval_decided,
      EVENT_SCHEMAS.settled,
    ]),
  },
  { additionalProperties: false },
);
export type EventMessage = Static<typeof EventSchema>;

// Approvals

/** One approval as approvers see it: what is asked, of which agent, and how it stands. */
export const ApprovalInfoSchema = Type.Object(
  {
    approvalId: Id,
    agent: Name,
    tool: Name,
    /** What the person is asked to approve, in words. */
    summary: Type.String(),
    status: Type.Enum(["pending", "approved", "declined"]),
    requestedAt: Type.String(),
    expiresAt: Type.String(),
    /** The number an approver's limit is checked against, when the approval declares one. */
    amount: Type.Optional(Type.Number()),
    /** Who decided: a principal id, absent for a timeout. */
    by: Type.Optional(Id),
    decidedAt: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ApprovalInfo = Static<typeof ApprovalInfoSchema>;

/** An approval asked for or decided, sent to the connections watching approvals. */
export const ApprovalMessageSchema = Type.Object(
  { type: Type.Literal("approval"), approval: ApprovalInfoSchema },
  { additionalProperties: false },
);
export type ApprovalMessage = Static<typeof ApprovalMessageSchema>;

// Directions

export type ClientMessage = Hello | ClientCommand;
export type ForwardedMessage = Hello | ForwardedCommand;
export type ServerMessage =
  | Welcome
  | Accepted
  | Result
  | ErrorMessage
  | EventMessage
  | ApprovalMessage;
export type Message = ClientMessage | ForwardedMessage | ServerMessage;

/**
 * Who sent a message: a `client` of the gateway, the `gateway` forwarding a client's command to the
 * runtime, or a `server` (gateway or runtime) answering.
 */
export type Sender = "client" | "gateway" | "server";
interface MessagesFrom {
  client: ClientMessage;
  gateway: ForwardedMessage;
  server: ServerMessage;
}

export type Validation<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/** A field whose value is one of several shapes, chosen by its `kind`. */
interface Variants {
  readonly field: string;
  readonly kinds: Readonly<Record<string, TSchema>>;
}

interface Shape {
  readonly schema: TSchema;
  readonly variants?: Variants;
}

const COMMANDS: Readonly<Record<string, Shape>> = {
  submit: {
    schema: SubmitSchema,
    variants: {
      field: "input",
      kinds: { message: MessageInputSchema, ticket: TicketInputSchema },
    },
  },
  subscribe: { schema: SubscribeSchema },
  get_state: { schema: GetStateSchema },
  list_agents: { schema: ListAgentsSchema },
  abort: { schema: AbortSchema },
  approve: { schema: ApproveSchema },
  watch_approvals: { schema: WatchApprovalsSchema },
  ping: { schema: PingSchema },
};

const SHAPES: Readonly<Record<Sender, Readonly<Record<string, Shape>>>> = {
  client: { hello: { schema: HelloSchema }, ...COMMANDS },
  gateway: { hello: { schema: HelloSchema }, ...COMMANDS },
  server: {
    welcome: { schema: WelcomeSchema },
    accepted: { schema: AcceptedSchema },
    result: { schema: ResultSchema },
    error: { schema: ErrorSchema },
    event: { schema: EventSchema, variants: { field: "event", kinds: EVENT_SCHEMAS } },
    approval: { schema: ApprovalMessageSchema },
  },
};

/**
 * Checks a decoded JSON value against the messages `from` may send and reports every problem, each
 * with its path. A client may never send `principal`; a command the gateway forwards must carry one.
 */
export function validateMessage<S extends Sender>(
  json: unknown,
  from: S,
): Validation<MessagesFrom[S]> {
  const problems = messageProblems(json, from);
  return problems.length === 0
    ? { ok: true, message: json as MessagesFrom[S] }
    : { ok: false, problems };
}

function messageProblems(json: unknown, from: Sender): Problem[] {
  if (!isObject(json)) return [{ path: "", message: `must be an object (got ${show(json)})` }];
  const shapes = SHAPES[from];
  const type = json.type;
  if (type === undefined) return [{ path: "type", message: "is required" }];
  const shape = typeof type === "string" ? own(shapes, type) : undefined;
  if (shape === undefined) {
    return [
      {
        path: "type",
        message: `must be one of ${listed(Object.keys(shapes))} (got ${show(type)})`,
      },
    ];
  }

  const problems = new Problems();
  // A present variant field is checked below against the one shape its `kind` names, rather than
  // reported once per shape it could have been. A missing one keeps its `is required`.
  const variants = shape.variants;
  const variantValue = variants === undefined ? undefined : json[variants.field];
  for (const problem of schemaProblems(shape.schema, json, "")) {
    if (
      variants !== undefined &&
      variantValue !== undefined &&
      isUnder(problem.path, variants.field)
    ) {
      continue;
    }
    problems.add(problem);
  }
  if (variants !== undefined && variantValue !== undefined) {
    problems.addAll(variantProblems(variants, variantValue));
  }

  if (typeof type === "string" && Object.hasOwn(COMMANDS, type)) {
    if (from === "client" && "principal" in json) {
      problems.removeUnder("principal");
      problems.add({
        path: "principal",
        message: "is added only by the gateway; a client may never send it",
      });
    } else if (from === "gateway" && !("principal" in json)) {
      problems.add({ path: "principal", message: "is required on a command the gateway forwards" });
    }
  }
  return problems.list;
}

function variantProblems(variants: Variants, value: unknown): Problem[] {
  const field = variants.field;
  if (!isObject(value)) return [{ path: field, message: `must be an object (got ${show(value)})` }];
  if (value.kind === undefined) return [{ path: `${field}.kind`, message: "is required" }];
  const schema = typeof value.kind === "string" ? own(variants.kinds, value.kind) : undefined;
  if (schema === undefined) {
    return [
      {
        path: `${field}.kind`,
        message: `must be one of ${listed(Object.keys(variants.kinds))} (got ${show(value.kind)})`,
      },
    ];
  }
  return schemaProblems(schema, value, field);
}

/** Translates TypeBox's errors into plain problems with readable paths. */
function schemaProblems(schema: TSchema, value: unknown, prefix: string): Problem[] {
  const problems = new Problems();
  for (const error of Value.Errors(schema, value)) {
    const path = join(prefix, pointerToPath(error.instancePath));
    const actual = valueAt(value, error.instancePath);
    const params = error.params as Record<string, unknown>;
    switch (error.keyword) {
      case "boolean":
        // `additionalProperties: false` reports each extra field twice; the named report wins.
        break;
      case "additionalProperties":
        for (const name of params.additionalProperties as string[]) {
          problems.add({ path: join(path, name), message: "is not a known field" });
        }
        break;
      case "required":
        for (const name of params.requiredProperties as string[]) {
          problems.add({ path: join(path, name), message: "is required" });
        }
        break;
      case "enum":
        problems.add({
          path,
          message: `must be one of ${listed(params.allowedValues as unknown[])} (got ${show(actual)})`,
        });
        break;
      case "const":
        problems.add({
          path,
          message: `must be ${show(params.allowedValue)} (got ${show(actual)})`,
        });
        break;
      case "type": {
        const type = String(params.type);
        const article = /^[aeiou]/.test(type) ? "an" : "a";
        problems.add({ path, message: `must be ${article} ${type} (got ${show(actual)})` });
        break;
      }
      case "minLength":
        problems.add({
          path,
          message:
            params.limit === 1
              ? "must not be empty"
              : `must be at least ${String(params.limit)} characters`,
        });
        break;
      case "maxLength":
        problems.add({ path, message: `must be at most ${String(params.limit)} characters` });
        break;
      case "minimum":
        problems.add({
          path,
          message: `must be at least ${String(params.limit)} (got ${show(actual)})`,
        });
        break;
      default:
        problems.add({ path, message: error.message });
    }
  }
  return problems.list;
}

/** The `invalid_message` error for a message that failed validation, listing every problem. */
export function invalidMessage(problems: readonly Problem[], id?: string): ErrorMessage {
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  const details = problems
    .map((problem) =>
      problem.path === "" ? problem.message : `${problem.path}: ${problem.message}`,
    )
    .join("; ");
  return {
    type: "error",
    ...(id === undefined ? {} : { id }),
    code: "invalid_message",
    message: `The message has ${count}: ${details}`,
    problems: [...problems],
  };
}

/**
 * The `id` to put on a reply to a message that failed validation: the message's own `id` when it is
 * a valid one, otherwise none, so the error itself always validates.
 */
export function replyId(json: unknown): string | undefined {
  if (!isObject(json)) return undefined;
  return Value.Check(Id, json.id) ? json.id : undefined;
}

/**
 * The runtime's key for a principal's request: `<principal id, URI-encoded>/<request id>`. The runtime
 * carries it in `accepted` and `event`, and the gateway maps it back to the client's own request id.
 * Encoding keeps `a/b` + `c` apart from `a` + `b/c`.
 *
 * The key is itself an id on the wire, so one that would pass the id limit (two long ids, or a
 * principal id that grows when encoded) is replaced by `sha256:<its SHA-256, in hex>`. That is the
 * same every time, so a retry still finds its request, and it has no `/`, so it is never a key a
 * shorter pair has.
 */
export function scopedRequestId(principal: Pick<Principal, "id">, requestId: string): string {
  const key = `${encodeURIComponent(principal.id)}/${requestId}`;
  return key.length <= ID_MAX_LENGTH ? key : `sha256:${sha256Hex(key)}`;
}

/**
 * Only the gateway and the runtime scope request ids, and both run on Node. Its hash is looked up
 * when needed rather than imported, so this module still loads in a browser for the client.
 */
function sha256Hex(text: string): string {
  const crypto =
    typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:crypto");
  if (crypto === undefined) {
    throw new Error("A request id this long can only be scoped on Node (it needs node:crypto).");
  }
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Answers a client's `hello`: `welcome` for version 1, `unsupported_version` for any other. */
export function handshake(hello: Hello, serverId: string): Welcome | ErrorMessage {
  if (hello.version === PROTOCOL_VERSION) {
    return { type: "welcome", version: PROTOCOL_VERSION, serverId };
  }
  return {
    type: "error",
    code: "unsupported_version",
    message: `This server speaks Gateway Protocol version ${PROTOCOL_VERSION}; the client asked for version ${show(hello.version)}.`,
  };
}

/** An ordered list of problems without repeats. */
class Problems {
  readonly list: Problem[] = [];
  readonly #seen = new Set<string>();

  add(problem: Problem): void {
    const key = `${problem.path}\u0000${problem.message}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.list.push(problem);
  }

  addAll(problems: readonly Problem[]): void {
    for (const problem of problems) this.add(problem);
  }

  removeUnder(field: string): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const problem = this.list[i];
      if (problem !== undefined && isUnder(problem.path, field)) this.list.splice(i, 1);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnder(path: string, field: string): boolean {
  return path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[`);
}

/** The longest a sender's value is quoted back in a problem; a reply must never outgrow a frame. */
const SHOWN_CHARACTERS = 60;

function show(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= SHOWN_CHARACTERS ? text : `${text.slice(0, SHOWN_CHARACTERS)}…`;
}

function listed(values: readonly unknown[]): string {
  return values.map(show).join(", ");
}

function join(path: string, child: string): string {
  if (child === "") return path;
  if (path === "" || child.startsWith("[")) return `${path}${child}`;
  return `${path}.${child}`;
}

/** `/input/text` → `input.text`, `/roles/0` → `roles[0]`. */
function pointerToPath(pointer: string): string {
  let path = "";
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    path = /^\d+$/.test(segment) ? `${path}[${segment}]` : join(path, segment);
  }
  return path;
}

function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const raw of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[raw.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

/** Looks up a key the record itself holds, so `"toString"` is not mistaken for a message type. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
