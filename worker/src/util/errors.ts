/**
 * util/errors.ts 
 *
 * fail()/failFromAppError() now include `sub_code` on the error body whenever
 * the AppError carries one. Previously an AppError's subCode field (added in
 * env.ts) had nowhere to go on the wire -- it was built but never serialized.
 * Now the client gets { code, message, sub_code } instead of just
 * { code, message }, so e.g. a 400 INVALID_INPUT can still carry
 * "course_completed" as a distinguishable machine code alongside a real
 * human-readable message.
 */

import type { AppError, ErrorCode } from "../env";

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((v) => {
      const s = stripUndefined(v);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? mapped : value) as unknown as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>);
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (v === undefined) {
        changed = true;
        continue;
      }
      const s = stripUndefined(v);
      if (s !== v) changed = true;
      out[k] = s;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

export interface OkOptions {
  httpStatus?: number;
}

export function ok(data: Record<string, unknown>, opts: OkOptions = {}): Response {
  const body: Record<string, unknown> = { ok: true, data: stripUndefined(data) };
  return new Response(JSON.stringify(body), {
    status: opts.httpStatus ?? 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function fail(code: ErrorCode, message: string, httpStatus = 400, subCode?: string): Response {
  const body = { ok: false, error: { code, message, ...(subCode ? { sub_code: subCode } : {}) } };
  return new Response(JSON.stringify(body), { status: httpStatus, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function failFromAppError(err: AppError): Response {
  return fail(err.code, err.message, err.httpStatus, err.subCode);
}