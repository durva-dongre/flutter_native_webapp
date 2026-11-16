/**
 * auth/magicLink.ts  
 *
 * Two fixes:
 *  1. ID_PATTERN widened from /^[A-Za-z0-9_-]{1,80}$/ to
 *     /^[A-Za-z0-9_ -]{1,255}$/ -- matching storage/keys.ts::
 *     FIELD_PATTERNS.assignment_id (space-tolerant) and the only real limit
 *     Frappe's create_magic_link_v2 enforces (len(id_bytes) > 255). The old,
 *     tighter pattern rejected a legitimate, space-containing assignment id
 *     ("Spaceship Assignment-62591") that Frappe already happily mints links
 *     for.
 *  2. verifyMagicLinkV2 no longer silently drops `dest` when the decoded id
 *     fails ID_PATTERN.test(id). The signature still verified -- the link is
 *     genuine -- but a malformed embedded dest id used to just become
 *     `dest = undefined`, sending the student to the generic home screen with
 *     zero indication anything was wrong. Now it throws invalidInput instead,
 *     surfacing the real bug rather than swallowing it.
 */

import { unauthorized, invalidInput } from "../env";
import { base32Decode, base32Encode, dashGroup, hmacSign, stripDashes } from "./hmac";
import { nowSeconds } from "../util/time";
import type { ConfigSchema } from "../config/defaults";

export type DestType = "home" | "feedback" | "submit" | "later" | "gallery";

const DEST_TYPE_BYTE: Record<DestType, number> = { home: 0, feedback: 1, submit: 2, later: 3, gallery: 4 };
const BYTE_TO_DEST_TYPE: Record<number, DestType> = { 0: "home", 1: "feedback", 2: "submit", 3: "later", 4: "gallery" };

export interface ParsedDest {
  type: DestType;
  id?: string;
}

// Matches storage/keys.ts::FIELD_PATTERNS.assignment_id exactly -- space-tolerant,
// up to 255 bytes to match what create_magic_link_v2 actually accepts on the
// Frappe side (shared/auth/magic_link.py: len(id_bytes) > 255 is the only
// rejection). Used both for parsing an inbound `dest` query param and for
// validating a decoded link's embedded id.
const ID_PATTERN = /^[A-Za-z0-9_ -]{1,255}$/;

export function parseDest(raw: string | undefined): ParsedDest | undefined {
  if (!raw || raw === "home") return undefined;
  const [typePart, idPart] = raw.split(":", 2);
  if (typePart === "later") return { type: "later" };
  if (typePart === "gallery") {
    if (idPart !== undefined && !ID_PATTERN.test(idPart)) return undefined;
    return { type: "gallery", id: idPart };
  }
  if (typePart === "feedback" || typePart === "submit") {
    if (!idPart || !ID_PATTERN.test(idPart)) return undefined;
    return { type: typePart, id: idPart };
  }
  return undefined;
}

export function formatDest(parsed: ParsedDest): string {
  if (parsed.type === "later") return "later";
  if (parsed.id) return `${parsed.type}:${parsed.id}`;
  return parsed.type;
}

function ttlForDest(cfg: ConfigSchema, type: DestType | "home"): number {
  switch (type) {
    case "feedback":
      return cfg.MAGIC_TTL_SECONDS_FEEDBACK;
    case "gallery":
      return cfg.MAGIC_TTL_SECONDS_GALLERY;
    case "submit":
      return cfg.MAGIC_TTL_SECONDS_SUBMIT;
    case "later":
      return cfg.MAGIC_TTL_SECONDS_LATER;
    default:
      return cfg.MAGIC_TTL_SECONDS_HOME;
  }
}

export interface MagicLinkPayload {
  phone: string;
  exp: number;
  dest?: ParsedDest;
}

const VERSION = 2;
const PHONE_FIXED_LEN = 12;
const NONCE_LEN = 8;
const HEADER_LEN = 1 + 1 + 4 + NONCE_LEN + 6;
const TAG_BYTES = 12;

function packPhoneDigits(phone: string): Uint8Array {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0 || digits.length > PHONE_FIXED_LEN) {
    throw invalidInput("phone must be 1-12 digits");
  }
  const padded = digits.padStart(PHONE_FIXED_LEN, "0");
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    const hi = Number(padded[i * 2]);
    const lo = Number(padded[i * 2 + 1]);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function unpackPhoneDigits(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += ((b >> 4) & 0xf).toString();
    out += (b & 0xf).toString();
  }
  return out.replace(/^0+(?=\d)/, "");
}

export async function createMagicLinkV2(
  secret: string,
  cfg: ConfigSchema,
  payload: { phone: string; dest?: ParsedDest }
): Promise<string> {
  const destType: DestType | "home" = payload.dest?.type ?? "home";
  const idBytes = payload.dest?.id ? new TextEncoder().encode(payload.dest.id) : new Uint8Array(0);
  if (idBytes.length > 255) throw invalidInput("dest id too long");

  const exp = nowSeconds() + ttlForDest(cfg, destType);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const phoneBytes = packPhoneDigits(payload.phone);

  const bodyLen = HEADER_LEN + 1 + idBytes.length;
  const buf = new Uint8Array(bodyLen);
  const view = new DataView(buf.buffer);

  let offset = 0;
  buf[offset++] = VERSION;
  buf[offset++] = DEST_TYPE_BYTE[destType];
  view.setUint32(offset, exp, false);
  offset += 4;
  buf.set(nonce, offset);
  offset += NONCE_LEN;
  buf.set(phoneBytes, offset);
  offset += 6;
  buf[offset++] = idBytes.length;
  buf.set(idBytes, offset);

  const tagFull = await hmacSign(secret, buf);
  const tag = tagFull.slice(0, TAG_BYTES);

  const combined = new Uint8Array(buf.length + tag.length);
  combined.set(buf, 0);
  combined.set(tag, buf.length);

  return dashGroup(base32Encode(combined));
}

async function constantTimeTagCompare(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export async function verifyMagicLinkV2(secret: string, code: string): Promise<MagicLinkPayload> {
  if (!code || typeof code !== "string") throw invalidInput("code missing");
  const stripped = stripDashes(code.trim());
  if (!/^[A-Za-z2-7]+$/.test(stripped)) throw invalidInput("code is not in the expected base32 format");

  let combined: Uint8Array;
  try {
    combined = base32Decode(stripped);
  } catch {
    throw invalidInput("code could not be decoded");
  }

  if (combined.length < HEADER_LEN + 1 + TAG_BYTES) throw invalidInput("code is too short to be valid");

  const version = combined[0] as number;
  if (version !== VERSION) {
    throw invalidInput("unsupported magic link version");
  }

  const idLen = combined[HEADER_LEN] as number;
  const bodyLen = HEADER_LEN + 1 + idLen;
  if (combined.length !== bodyLen + TAG_BYTES) {
    throw invalidInput("code length does not match its declared payload length");
  }

  const payloadBytes = combined.slice(0, bodyLen);
  const tag = combined.slice(bodyLen, bodyLen + TAG_BYTES);

  const expectedFull = await hmacSign(secret, payloadBytes);
  const expectedTag = expectedFull.slice(0, TAG_BYTES);
  if (!(await constantTimeTagCompare(expectedTag, tag))) {
    throw unauthorized("magic link signature does not verify");
  }

  const view = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
  const destTypeByte = payloadBytes[1] as number;
  const exp = view.getUint32(2, false);
  const phoneBytes = payloadBytes.slice(6 + NONCE_LEN, 6 + NONCE_LEN + 6);
  const phone = unpackPhoneDigits(phoneBytes);
  const idBytes = payloadBytes.slice(HEADER_LEN + 1);
  const id = idBytes.length > 0 ? new TextDecoder().decode(idBytes) : undefined;

  if (exp < nowSeconds()) throw unauthorized("magic link has expired");

  const destType = BYTE_TO_DEST_TYPE[destTypeByte];
  let dest: ParsedDest | undefined;
  if (destType && destType !== "home") {
    if (id !== undefined && !ID_PATTERN.test(id)) {
      // The signature verified -- this link is genuine -- but its embedded
      // dest id is malformed. Fail loudly instead of silently dropping the
      // whole dest and sending the student to the generic home screen with
      // no indication anything was wrong.
      throw invalidInput("magic link's destination id is malformed");
    }
    dest = { type: destType, id };
  }

  return { phone, exp, dest };
}