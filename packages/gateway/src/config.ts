/**
 * `gateway.json`: where the gateway listens, how it starts its runtime, how it checks tokens, and who
 * may do what. It holds paths and rules only. Keys come from the environment: the JWT public key from
 * `OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY`, and the runtime's model credentials from its own environment.
 *
 * ```json
 * {
 *   "version": 1,
 *   "listen": { "host": "127.0.0.1", "port": 8443 },
 *   "tls": { "cert": "tls/cert.pem", "key": "tls/key.pem" },
 *   "runtime": { "command": "officehum", "args": ["runtime", "--db", "office.sqlite", "--office", "office.json"] },
 *   "auth": { "issuer": "https://login.example.com", "audience": "officehum" },
 *   "permissions": {
 *     "submit": [{ "roles": ["staff"], "agents": "*" }],
 *     "approve": [{ "roles": ["manager"], "agents": ["bookkeeper"], "limit": 5000 }],
 *     "abort": [{ "roles": ["staff"] }]
 *   },
 *   "limits": { "perPrincipal": 32, "perAddress": 64, "total": 1024, "expiredGraceSeconds": 60 }
 * }
 * ```
 *
 * Relative paths (TLS files, the runtime's working directory) resolve against the file's directory.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Roles a rule applies to; `"*"` is every signed-in principal. */
export type RoleList = readonly string[];

export interface SubmitRule {
  readonly roles: RoleList;
  /** The agents these roles may submit to; `"*"` is every agent. */
  readonly agents: readonly string[] | "*";
}

export interface ApproveRule {
  readonly roles: RoleList;
  /** The agents whose approvals these roles may decide; `"*"` (the default) is every agent. */
  readonly agents: readonly string[] | "*";
  /** The most these roles may approve; omitted is no limit beyond the token's own. */
  readonly limit?: number;
}

export interface AbortRule {
  readonly roles: RoleList;
}

/** Deny by default: a command no rule allows is refused as `forbidden`. */
export interface Permissions {
  readonly submit: readonly SubmitRule[];
  readonly approve: readonly ApproveRule[];
  readonly abort: readonly AbortRule[];
}

export interface GatewayConfig {
  readonly listen: { readonly host: string; readonly port: number };
  /** Serve HTTPS and WSS. `clientCa` turns on mutual TLS: clients must present a certificate it signed. */
  readonly tls?: { readonly cert: string; readonly key: string; readonly clientCa?: string };
  /** The runtime process: `officehum runtime --db … --office …`, or anything that speaks it. */
  readonly runtime: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  };
  readonly auth: { readonly issuer?: string; readonly audience?: string };
  readonly permissions: Permissions;
  /** A client whose unsent output passes this many bytes is disconnected. Default 8 MiB. */
  readonly clientBufferBytes: number;
  readonly limits: ConnectionLimitsConfig;
}

/** How many connections the gateway holds at once, so one caller cannot exhaust it. */
export interface ConnectionLimitsConfig {
  /** WebSockets and event streams one principal may hold open. Default 32. */
  readonly perPrincipal: number;
  /** Connections of any kind from one remote address. Default 64. */
  readonly perAddress: number;
  /** Connections of any kind, from everyone. Default 1024. */
  readonly total: number;
  /** How long a WebSocket whose token expired may stay open without a fresh `hello`. Default 60. */
  readonly expiredGraceSeconds: number;
}

/** The longest an expired WebSocket may wait for a fresh `hello`: a day. */
const MAX_GRACE_SECONDS = 86_400;

export const DEFAULT_LIMITS: ConnectionLimitsConfig = {
  perPrincipal: 32,
  perAddress: 64,
  total: 1024,
  expiredGraceSeconds: 60,
};

const DEFAULT_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;

/** Reads and checks `gateway.json`, reporting every problem with its path at once. */
export async function readGatewayConfig(path: string): Promise<GatewayConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read the gateway config ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The gateway config ${path} is not JSON: ${String(error)}`, { cause: error });
  }
  return parseGatewayConfig(parsed, dirname(resolve(path)), path);
}

/** Checks parsed config; `base` is the directory relative paths resolve against. */
export function parseGatewayConfig(
  value: unknown,
  base: string,
  source = "gateway config",
): GatewayConfig {
  const problems: string[] = [];
  const problem = (path: string, message: string) => problems.push(`${path}: ${message}`);
  if (!isObject(value)) throw new Error(`The ${source} must be a JSON object.`);

  known(
    value,
    ["version", "listen", "tls", "runtime", "auth", "permissions", "clientBufferBytes", "limits"],
    "",
    problem,
  );
  if (value.version !== 1) problem("version", `must be 1 (got ${show(value.version)})`);

  const listen = objectAt(value, "listen", problem);
  if (listen !== undefined) {
    known(listen, ["host", "port"], "listen", problem);
    if (typeof listen.host !== "string" || listen.host === "")
      problem("listen.host", "must be a host name or address");
    if (
      !Number.isInteger(listen.port) ||
      (listen.port as number) < 0 ||
      (listen.port as number) > 65_535
    ) {
      problem("listen.port", `must be a port number, 0–65535 (got ${show(listen.port)})`);
    }
  }

  let tls: GatewayConfig["tls"];
  if (value.tls !== undefined) {
    const raw = objectAt(value, "tls", problem);
    if (raw !== undefined) {
      known(raw, ["cert", "key", "clientCa"], "tls", problem);
      for (const field of ["cert", "key"] as const) {
        if (typeof raw[field] !== "string" || raw[field] === "")
          problem(`tls.${field}`, "must be a file path");
      }
      if (raw.clientCa !== undefined && (typeof raw.clientCa !== "string" || raw.clientCa === "")) {
        problem("tls.clientCa", "must be a file path");
      }
      if (typeof raw.cert === "string" && typeof raw.key === "string") {
        tls = {
          cert: resolve(base, raw.cert),
          key: resolve(base, raw.key),
          ...(typeof raw.clientCa === "string" ? { clientCa: resolve(base, raw.clientCa) } : {}),
        };
      }
    }
  }

  const runtime = objectAt(value, "runtime", problem);
  if (runtime !== undefined) {
    known(runtime, ["command", "args", "cwd"], "runtime", problem);
    if (typeof runtime.command !== "string" || runtime.command === "") {
      problem("runtime.command", 'must be the program to run, e.g. "officehum"');
    }
    if (!Array.isArray(runtime.args) || runtime.args.some((arg) => typeof arg !== "string")) {
      problem(
        "runtime.args",
        'must be a list of strings, e.g. ["runtime", "--db", "office.sqlite", "--office", "office.json"]',
      );
    }
    if (runtime.cwd !== undefined && typeof runtime.cwd !== "string")
      problem("runtime.cwd", "must be a directory");
  }

  const auth = value.auth === undefined ? {} : objectAt(value, "auth", problem);
  if (auth !== undefined) {
    known(auth, ["issuer", "audience"], "auth", problem);
    for (const field of ["issuer", "audience"] as const) {
      if (auth[field] !== undefined && (typeof auth[field] !== "string" || auth[field] === "")) {
        problem(`auth.${field}`, "must be a non-empty string");
      }
    }
  }

  const permissions = parsePermissions(value.permissions, problem);

  if (
    value.clientBufferBytes !== undefined &&
    (!Number.isInteger(value.clientBufferBytes) || (value.clientBufferBytes as number) <= 0)
  ) {
    problem(
      "clientBufferBytes",
      `must be a positive whole number of bytes (got ${show(value.clientBufferBytes)})`,
    );
  }

  const limits: Record<string, number> = { ...DEFAULT_LIMITS };
  if (value.limits !== undefined) {
    const raw = objectAt(value, "limits", problem);
    if (raw !== undefined) {
      known(raw, Object.keys(DEFAULT_LIMITS), "limits", problem);
      for (const field of Object.keys(DEFAULT_LIMITS)) {
        const given = raw[field];
        if (given === undefined) continue;
        if (!Number.isInteger(given) || (given as number) <= 0) {
          problem(`limits.${field}`, `must be a positive whole number (got ${show(given)})`);
        } else if (field === "expiredGraceSeconds" && (given as number) > MAX_GRACE_SECONDS) {
          problem(
            "limits.expiredGraceSeconds",
            `must be at most ${MAX_GRACE_SECONDS} (a day; got ${show(given)})`,
          );
        } else {
          limits[field] = given as number;
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`The ${source} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }
  const ok = <T>(item: T | undefined): T => item as T;
  return {
    listen: { host: ok(listen).host as string, port: ok(listen).port as number },
    ...(tls === undefined ? {} : { tls }),
    runtime: {
      command: ok(runtime).command as string,
      args: ok(runtime).args as string[],
      cwd: resolve(base, (ok(runtime).cwd as string | undefined) ?? "."),
    },
    auth: {
      ...(typeof auth?.issuer === "string" ? { issuer: auth.issuer } : {}),
      ...(typeof auth?.audience === "string" ? { audience: auth.audience } : {}),
    },
    permissions,
    clientBufferBytes:
      (value.clientBufferBytes as number | undefined) ?? DEFAULT_CLIENT_BUFFER_BYTES,
    limits: limits as unknown as ConnectionLimitsConfig,
  };
}

function parsePermissions(
  value: unknown,
  problem: (path: string, message: string) => void,
): Permissions {
  const empty: Permissions = { submit: [], approve: [], abort: [] };
  if (value === undefined) return empty;
  if (!isObject(value)) {
    problem("permissions", "must be an object with submit, approve and abort rules");
    return empty;
  }
  known(value, ["submit", "approve", "abort"], "permissions", problem);
  const rules = (name: "submit" | "approve" | "abort", fields: readonly string[]) => {
    const list = value[name] ?? [];
    if (!Array.isArray(list)) {
      problem(`permissions.${name}`, "must be a list of rules");
      return [];
    }
    // Each rule keeps its place in the file: a later problem must name the rule the operator wrote,
    // not its position among the rules that survived this pass.
    return list.flatMap((rule: unknown, index) => {
      const at = `permissions.${name}[${index}]`;
      if (!isObject(rule)) {
        problem(at, "must be an object with roles");
        return [];
      }
      known(rule, fields, at, problem);
      if (!isRoleList(rule.roles)) {
        problem(`${at}.roles`, 'must be a non-empty list of role names, or ["*"]');
        return [];
      }
      return [{ rule, at }];
    });
  };

  const submit = rules("submit", ["roles", "agents"]).flatMap(({ rule, at }) => {
    const agents = rule.agents;
    if (agents !== "*" && !(Array.isArray(agents) && agents.length > 0 && agents.every(isName))) {
      problem(`${at}.agents`, 'must be a list of agent ids, or "*"');
      return [];
    }
    return [{ roles: rule.roles as string[], agents: agents as string[] | "*" }];
  });
  const approve = rules("approve", ["roles", "agents", "limit"]).flatMap(({ rule, at }) => {
    if (rule.limit !== undefined && (typeof rule.limit !== "number" || rule.limit < 0)) {
      problem(`${at}.limit`, "must be a number, 0 or more");
      return [];
    }
    const agents = rule.agents ?? "*";
    if (agents !== "*" && !(Array.isArray(agents) && agents.length > 0 && agents.every(isName))) {
      problem(`${at}.agents`, 'must be a list of agent ids, or "*"');
      return [];
    }
    return [
      {
        roles: rule.roles as string[],
        agents: agents as string[] | "*",
        ...(rule.limit === undefined ? {} : { limit: rule.limit as number }),
      },
    ];
  });
  const abort = rules("abort", ["roles"]).map(({ rule }) => ({ roles: rule.roles as string[] }));
  return { submit, approve, abort };
}

function isRoleList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isName);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function objectAt(
  value: Record<string, unknown>,
  key: string,
  problem: (path: string, message: string) => void,
): Record<string, unknown> | undefined {
  const found = value[key];
  if (!isObject(found)) {
    problem(key, found === undefined ? "is required" : "must be an object");
    return undefined;
  }
  return found;
}

function known(
  value: Record<string, unknown>,
  fields: readonly string[],
  at: string,
  problem: (path: string, message: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) problem(at === "" ? key : `${at}.${key}`, "is not a known field");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return value === undefined ? "nothing" : (JSON.stringify(value) ?? String(value));
}
