/**
 * handlers/telemetryHandlers.ts — /telemetry/flush, fallback path used
 * only when the app's local buffer is non-empty and ~60s passed with no
 * other call to piggyback telemetry on.
 *
 * FIX: analytics threaded through and passed into enforceRateLimit.
 */

import { requireStudentToken } from "../auth/middleware";
import type { Env } from "../env";
import { invalidInput } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { collectTelemetrySync } from "../telemetry/collector";
import type { RequestAnalyticsContext } from "../router";

const ROUTE_FLUSH = "/telemetry/flush";

interface FlushBody { _t?: unknown; }

async function flush(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "telemetry", ROUTE_FLUSH, analytics);

  const body = (await req.json().catch(() => ({}))) as FlushBody;
  if (!body._t || typeof body._t !== "object" || Object.keys(body._t).length === 0) {
    throw invalidInput("_t missing or entirely empty");
  }

  const accepted = await collectTelemetrySync(env, studentId, body._t);
  return ok({ accepted });
}

export const telemetryHandlers = { flush };