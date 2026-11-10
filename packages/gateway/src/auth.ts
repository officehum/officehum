/**
 * Who is calling: a JWT bearer token, verified with the office's public key, becomes the `principal`
 * the gateway attaches to every command it forwards. The token is the only source of identity; no
 * message field can set or change it.
 *
 * Claims: `sub` is the principal id, `roles` (strings) its roles, `approvalLimit` (a number, optional)
 * the most it may approve. `exp` is required, so a leaked token cannot work forever. `iss` and `aud`
 * are checked when the gateway config names them. The accepted algorithm follows the key: RSA → RS256,
 * P-256 → ES256, Ed25519 → EdDSA; a token signed any other way is refused.
 */

import { createPublicKey, type KeyObject } from "node:crypto";
import type { Principal } from "@officehum/protocol";
import { errors, jwtVerify } from "jose";

/** The environment variable holding the PEM public key tokens are verified with. */
export const JWT_PUBLIC_KEY_ENV = "OFFICEHUM_GATEWAY_JWT_PUBLIC_KEY";

export class AuthError extends Error {}

export interface VerifyOptions {
  readonly issuer?: string;
  readonly audience?: string;
}

/** The verification key and the one algorithm it is used with. */
export interface TokenKey {
  readonly key: KeyObject;
  readonly algorithm: "RS256" | "ES256" | "EdDSA";
}

/** Reads a PEM public key (SPKI) and picks its algorithm. */
export function tokenKey(pem: string): TokenKey {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new Error(`${JWT_PUBLIC_KEY_ENV} is not a PEM public key: ${String(error)}`, {
      cause: error,
    });
  }
  switch (key.asymmetricKeyType) {
    case "rsa":
      return { key, algorithm: "RS256" };
    case "ec":
      if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") break;
      return { key, algorithm: "ES256" };
    case "ed25519":
      return { key, algorithm: "EdDSA" };
  }
  throw new Error(
    `${JWT_PUBLIC_KEY_ENV} must be an RSA, P-256 or Ed25519 public key (got ${key.asymmetricKeyType}${
      key.asymmetricKeyDetails?.namedCurve === undefined
        ? ""
        : ` ${key.asymmetricKeyDetails.namedCurve}`
    }).`,
  );
}

/** Reads the key from the environment, failing with what to set when it is missing. */
export function tokenKeyFromEnvironment(env: NodeJS.ProcessEnv = process.env): TokenKey {
  const pem = env[JWT_PUBLIC_KEY_ENV]?.trim();
  if (pem === undefined || pem === "") {
    throw new Error(
      `Set ${JWT_PUBLIC_KEY_ENV} to the PEM public key client tokens are signed for.`,
    );
  }
  return tokenKey(pem);
}

/** A verified token: who it is, and until when (milliseconds since the epoch). */
export interface VerifiedToken {
  readonly principal: Principal;
  readonly expiresAt: number;
}

/** Verifies a bearer token and returns its principal, or throws `AuthError` saying why not. */
export async function verifyToken(
  token: string,
  key: TokenKey,
  options: VerifyOptions = {},
): Promise<VerifiedToken> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key.key, {
      algorithms: [key.algorithm],
      requiredClaims: ["exp", "sub"],
      ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
      ...(options.audience === undefined ? {} : { audience: options.audience }),
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired)
      throw new AuthError("The token has expired; sign in again.");
    if (error instanceof errors.JOSEError) {
      throw new AuthError(`The token was refused: ${error.message}`);
    }
    throw error;
  }
  const { sub, roles, approvalLimit, exp } = payload;
  if (typeof sub !== "string" || sub === "" || sub.length > 256) {
    throw new AuthError("The token's sub must be the caller's id, 1 to 256 characters.");
  }
  if (
    roles !== undefined &&
    !(Array.isArray(roles) && roles.every((role) => typeof role === "string" && role !== ""))
  ) {
    throw new AuthError("The token's roles must be a list of role names.");
  }
  if (approvalLimit !== undefined && (typeof approvalLimit !== "number" || approvalLimit < 0)) {
    throw new AuthError("The token's approvalLimit must be a number, 0 or more.");
  }
  return {
    principal: {
      id: sub,
      roles: (roles as string[] | undefined) ?? [],
      ...(approvalLimit === undefined ? {} : { approvalLimit: approvalLimit as number }),
    },
    // `requiredClaims` guarantees `exp`, and jose has checked it is a number in the future.
    expiresAt: (exp as number) * 1000,
  };
}

/** The token from an `Authorization: Bearer …` header, if there is one. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}
