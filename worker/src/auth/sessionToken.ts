/**
 * auth/sessionToken.ts — mints and verifies the two session tokens:
 *   - STUDENT token, scoped to one student_id — minted after /auth/redeem (for every
 *     student in the roster, embedded directly in that student's own payload object)
 *     or /auth/select_profile (fallback path, for whichever student the app switches
 *     to when its cached student token is gone).
 *   - PHONE token, scoped to one phone number — minted on every /auth/redeem, so the
 *     app can always call /auth/select_profile as a fallback to re-derive a student
 *     token for any student on the phone, regardless of how many there are.
 *
 * Tokens are fixed-TTL, minted once (ConfigSchema.STUDENT_TOKEN_TTL_SECONDS /
 * PHONE_TOKEN_TTL_SECONDS) and nothing extends it on subsequent calls — there is no
 * refreshed_token anywhere in the response surface (Contract §4.5). When a student
 * token expires or the app's local cache of it is cleared, the app re-derives one via
 * /auth/select_profile using its still-valid phone token.
 *
 * FORMAT — standard JWT (header.payload.signature, base64url JSON, HS256), NOT the
 * custom binary-packed-then-base32-dashed shape magic links use (auth/magicLink.ts).
 * This is a deliberate split:
 *   - Magic links (auth/magicLink.ts) stay a compact, dash-grouped base32 string —
 *     meant to be typed/read/shared as a short code, so byte-density matters.
 *   - Session tokens (this file) are carried in an Authorization header and consumed
 *     only by code (the app, never a human), so there's no benefit to a dense custom
 *     encoding — a normal JWT is simpler to inspect, log, and debug, and every claim
 *     (typ, sid/phone, iat, exp) is visible without writing a custom decoder.
 *
 * The JWT's own "exp" claim (seconds since epoch, per RFC 7519) is what verification
 * checks — not a custom binary expiry field. There is still no "used"/nonce tracking:
 * the same token verifies identically on every call until its own exp passes, exactly
 * as before.
 *
 * Header is always the fixed, literal JSON {"alg":"HS256","typ":"JWT"} — verification
 * re-derives and compares the encoded header rather than trusting whatever header the
 * token carries, so a token can never select its own algorithm (this also closes the
 * classic "alg: none" JWT confusion attack by construction: there is only ever one
 * algorithm, and it is never read from the token itself).
 */

import { unauthorized, invalidInput } from "../env";
import { base64urlEncode, base64urlDecode, hmacSign, hmacVerify } from "./hmac";
import { nowSeconds } from "../util/time";

export type TokenKind = "student" | "phone";

export interface StudentTokenClaims {
  sid: string;
}
export interface PhoneTokenClaims {
  phone: string;
}
export type TokenClaims = StudentTokenClaims | PhoneTokenClaims;

interface TokenSecrets {
  STUDENT_TOKEN_SECRET: string;
  PHONE_TOKEN_SECRET: string;
}

/** The one, fixed JWT header this codebase ever issues or accepts — see module
 *  docblock for why this is a hardcoded literal rather than read from the token. */
const JWT_HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';

function secretFor(kind: TokenKind, env: TokenSecrets): string {
  return kind === "student" ? env.STUDENT_TOKEN_SECRET : env.PHONE_TOKEN_SECRET;
}

interface RawClaims {
  typ: TokenKind;
  sid?: string;
  phone?: string;
  iat: number;
  exp: number;
}

async function mintToken(kind: TokenKind, subject: string, secret: string, ttlSeconds: number): Promise<string> {
  const iat = nowSeconds();
  const exp = iat + ttlSeconds;

  const claims: RawClaims =
    kind === "student" ? { typ: "student", sid: subject, iat, exp } : { typ: "phone", phone: subject, iat, exp };

  const encoder = new TextEncoder();
  const headerB64 = base64urlEncode(encoder.encode(JWT_HEADER_JSON));
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await hmacSign(secret, encoder.encode(signingInput));
  const signatureB64 = base64urlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/** Fixed-TTL mint — ttlSeconds is required (caller passes cfg.STUDENT_TOKEN_TTL_SECONDS). */
export async function mintStudentToken(studentId: string, env: TokenSecrets, ttlSeconds: number): Promise<string> {
  return mintToken("student", studentId, secretFor("student", env), ttlSeconds);
}

/** Fixed-TTL mint — ttlSeconds is required (caller passes cfg.PHONE_TOKEN_TTL_SECONDS). */
export async function mintPhoneToken(phone: string, env: TokenSecrets, ttlSeconds: number): Promise<string> {
  return mintToken("phone", phone, secretFor("phone", env), ttlSeconds);
}

/**
 * Verifies a JWT-shaped session token: splits on ".", recomputes the expected
 * signature over "header.payload" using the kind-appropriate secret, compares it
 * constant-time against the token's own signature segment, then checks typ and exp.
 *
 * The header is NEVER read to decide the algorithm or re-derived from the token's own
 * bytes for signing — it is only ever compared, byte-for-byte (via the recomputed
 * headerB64 baked from the fixed JWT_HEADER_JSON constant), against what the token
 * actually carries. A token whose header segment doesn't decode to exactly
 * JWT_HEADER_JSON fails verification outright, before the signature is even checked —
 * this is what prevents an attacker from asking the verifier to use a different
 * algorithm (e.g. "alg":"none") than the one this code always signs with.
 */
export async function verifySessionToken(
  token: string | null,
  expectedKind: TokenKind,
  env: TokenSecrets
): Promise<TokenClaims> {
  if (!token) throw unauthorized("missing bearer token");

  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) throw unauthorized("token is not in the expected format");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const encoder = new TextEncoder();
  const expectedHeaderB64 = base64urlEncode(encoder.encode(JWT_HEADER_JSON));
  if (headerB64 !== expectedHeaderB64) {
    throw unauthorized("token header is not recognized");
  }

  // Secret selection must happen based on expectedKind (the route's own
  // requirement), not on anything read from the still-unverified token — otherwise a
  // token forged/signed under one kind's secret could claim to be the other kind and
  // get verified against the wrong secret.
  const secret = secretFor(expectedKind, env);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64urlDecode(signatureB64);
  } catch {
    throw unauthorized("token signature could not be decoded");
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const verified = await hmacVerify(secret, encoder.encode(signingInput), signatureBytes);
  if (!verified) {
    throw unauthorized("token signature does not verify");
  }

  let claims: RawClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))) as RawClaims;
  } catch {
    throw unauthorized("token payload could not be decoded");
  }

  if (claims.typ !== expectedKind) throw unauthorized("token kind does not match this route");
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds()) throw unauthorized("token has expired");

  if (expectedKind === "student") {
    if (!claims.sid) throw invalidInput("token missing sid claim");
    return { sid: claims.sid };
  }
  if (!claims.phone) throw invalidInput("token missing phone claim");
  return { phone: claims.phone };
}