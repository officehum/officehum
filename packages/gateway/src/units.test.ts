import { generateKeyPairSync } from "node:crypto";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { AuthError, bearerToken, tokenKey, tokenKeyFromEnvironment, verifyToken } from "./auth.js";
import { parseGatewayConfig } from "./config.js";
import { decide, mayApprove } from "./permissions.js";

describe("parseGatewayConfig", () => {
  const minimal = {
    version: 1,
    listen: { host: "127.0.0.1", port: 8443 },
    runtime: { command: "officehum", args: ["runtime", "--db", "o.sqlite", "--office", "o.json"] },
  };

  it("reads a config, resolving paths against its directory and denying everything by default", () => {
    expect(
      parseGatewayConfig({ ...minimal, tls: { cert: "tls/c.pem", key: "tls/k.pem" } }, "/srv/gw"),
    ).toEqual({
      listen: { host: "127.0.0.1", port: 8443 },
      tls: { cert: "/srv/gw/tls/c.pem", key: "/srv/gw/tls/k.pem" },
      runtime: { command: "officehum", args: minimal.runtime.args, cwd: "/srv/gw" },
      auth: {},
      permissions: { submit: [], approve: [], abort: [] },
      clientBufferBytes: 8 * 1024 * 1024,
    });
  });

  it("reports every problem with its path", () => {
    expect(() =>
      parseGatewayConfig(
        {
          version: 1,
          listen: { host: "", port: 70_000 },
          runtime: { command: "officehum", args: "runtime" },
          permissions: {
            submit: [{ roles: [], agents: "*" }],
            approve: [{ roles: ["m"], limit: -1 }],
          },
          secret: "x",
        },
        "/srv",
        "gateway.json",
      ),
    ).toThrow(
      [
        "The gateway.json has 6 problem(s):",
        "  secret: is not a known field",
        "  listen.host: must be a host name or address",
        "  listen.port: must be a port number, 0–65535 (got 70000)",
        '  runtime.args: must be a list of strings, e.g. ["runtime", "--db", "office.sqlite", "--office", "office.json"]',
        '  permissions.submit[0].roles: must be a non-empty list of role names, or ["*"]',
        "  permissions.approve[0].limit: must be a number, 0 or more",
      ].join("\n"),
    );
  });
});

describe("tokens", () => {
  it("verifies a token and turns its claims into a principal", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    const key = tokenKey(await exportSPKI(publicKey));
    expect(key.algorithm).toBe("EdDSA");
    const signed = await new SignJWT({ roles: ["staff"], approvalLimit: 250 })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("ada")
      .setIssuer("login")
      .setExpirationTime("5m")
      .sign(privateKey);
    const verified = await verifyToken(signed, key, { issuer: "login" });
    expect(verified.principal).toEqual({ id: "ada", roles: ["staff"], approvalLimit: 250 });
    expect(verified.expiresAt).toBeGreaterThan(Date.now());
    await expect(verifyToken(signed, key, { issuer: "elsewhere" })).rejects.toThrow(AuthError);
  });

  it("refuses a token without exp, or with bad claims", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const key = tokenKey(await exportSPKI(publicKey));
    const noExpiry = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("ada")
      .sign(privateKey);
    await expect(verifyToken(noExpiry, key)).rejects.toThrow(/exp/);
    const badRoles = await new SignJWT({ roles: "staff" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("ada")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyToken(badRoles, key)).rejects.toThrow("roles must be a list");
  });

  it("picks the algorithm from the key and refuses keys it does not support", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(tokenKey(String(rsa)).algorithm).toBe("RS256");
    const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(() => tokenKey(String(k1))).toThrow("must be an RSA, P-256 or Ed25519 public key");
    expect(() => tokenKeyFromEnvironment({})).toThrow("Set OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY");
  });

  it("reads a bearer header", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("decide", () => {
  const permissions = {
    submit: [
      { roles: ["sales"], agents: ["sales"] },
      { roles: ["*"], agents: ["front-desk"] },
    ],
    approve: [{ roles: ["manager"], agents: ["bookkeeper"] }],
    abort: [],
  };
  const sam = { id: "sam", roles: ["sales"] };

  it("allows submit only to the agents a rule names for one of the roles", () => {
    const to = (agent: string) =>
      decide(permissions, sam, {
        type: "submit",
        id: "c",
        agent,
        requestId: "r",
        input: { kind: "message", text: "x" },
      });
    expect(to("sales").allowed).toBe(true);
    expect(to("front-desk").allowed).toBe(true);
    expect(to("bookkeeper")).toEqual({
      allowed: false,
      reason: "You may not submit work to bookkeeper.",
    });
  });

  it("denies abort and approve with no rule, and passes read-only commands", () => {
    expect(decide(permissions, sam, { type: "abort", id: "c", requestId: "r" }).allowed).toBe(
      false,
    );
    expect(
      decide(
        permissions,
        sam,
        { type: "approve", id: "c", approvalId: "a", decision: "approve" },
        "bookkeeper",
      ).allowed,
    ).toBe(false);
    expect(decide(permissions, sam, { type: "watch_approvals", id: "c" }).allowed).toBe(false);
    expect(decide(permissions, sam, { type: "list_agents", id: "c" }).allowed).toBe(true);
  });

  it("keeps the token's limit when the rule sets none", () => {
    const manager = { id: "m", roles: ["manager"], approvalLimit: 10 };
    expect(
      decide(
        permissions,
        manager,
        { type: "approve", id: "c", approvalId: "a", decision: "approve" },
        "bookkeeper",
      ),
    ).toEqual({
      allowed: true,
      principal: manager,
    });
  });

  it("allows approve only for the agents a rule names", () => {
    const manager = { id: "m", roles: ["manager"] };
    const approve = { type: "approve", id: "c", approvalId: "a", decision: "approve" } as const;
    expect(decide(permissions, manager, approve, "bookkeeper").allowed).toBe(true);
    expect(decide(permissions, manager, approve, "sales")).toEqual({
      allowed: false,
      reason: "You may not approve actions for sales.",
    });
    expect(mayApprove(permissions, manager, "sales")).toBe(false);
    expect(decide(permissions, manager, { type: "watch_approvals", id: "w" }).allowed).toBe(true);
  });
});
