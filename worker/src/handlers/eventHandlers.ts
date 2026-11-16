/**
 * handlers/eventHandlers.ts
 * /events/is_enrolled is the SOLE source of event-track resume state in the
 * whole API — there is no current_event_learning_unit on any resume
 * payload. last_activity_type here uses the same "video"|"quiz"|
 * "submission"|null vocabulary as the program track's own field, just
 * scoped to this one event_id.
 *
 * FIX: `analytics` now threaded through both handlers and into
 * enforceRateLimit with each route's own path, and noteFrappeCall is
 * called after every Frappe call — same wiring fix as the rest of this
 * batch.
 */

import { requireStudentToken } from "../auth/middleware";
import { fetchFrappe } from "../frappe/client";
import { FRAPPE_METHODS } from "../frappe/mapRequest";
import type { Env } from "../env";
import { invalidInput } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { withIdempotency } from "../cache/idempotency";
import { isValidIdempotencyKey } from "../util/ids";
import { collectTelemetry } from "../telemetry/collector";
import { config } from "../config/index";
import type { LastActivityType } from "./authHandlers";
import type { RequestAnalyticsContext } from "../router";

const ROUTE_ENROLL = "/events/enroll";
const ROUTE_IS_ENROLLED = "/events/is_enrolled";

interface EnrollBody { event_id?: string; idempotency_key?: string; _t?: unknown; }
interface EnrollResult { enrolled: boolean; already_enrolled: boolean; }

async function enroll(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_ENROLL, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as EnrollBody;
  if (!body.event_id) throw invalidInput("event_id missing");
  if (!isValidIdempotencyKey(body.idempotency_key)) throw invalidInput("idempotency_key missing or invalid");

  const { result, repeat } = await withIdempotency<EnrollResult>(
    "enroll_event",
    studentId,
    body.idempotency_key,
    cfg.IDEMPOTENCY_TTL_BY_ROUTE.enroll_event ?? cfg.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    async () => {
      const r = await fetchFrappe<EnrollResult>(env, FRAPPE_METHODS.enrollEvent, {
        student_id: studentId,
        event_id: body.event_id,
      });
      analytics.noteFrappeCall(FRAPPE_METHODS.enrollEvent);
      return r;
    }
  );
  analytics.noteIdempotencyRepeat(repeat);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({
    event_id: body.event_id,
    student_id: studentId,
    enrolled: result.enrolled,
    already_enrolled: result.already_enrolled,
    repeat,
  });
}

interface IsEnrolledBody { event_id?: string; _t?: unknown; }
interface IsEnrolledFrappeResult {
  enrolled: boolean;
  last_activity_type: LastActivityType;
  current_event_learning_unit: string | null;
}

async function isEnrolled(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_IS_ENROLLED, analytics);

  const body = (await req.json().catch(() => ({}))) as IsEnrolledBody;
  if (!body.event_id) throw invalidInput("event_id missing");

  const result = await fetchFrappe<IsEnrolledFrappeResult>(env, FRAPPE_METHODS.isEnrolled, {
    student_id: studentId,
    event_id: body.event_id,
  });
  analytics.noteFrappeCall(FRAPPE_METHODS.isEnrolled);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({
    enrolled: result.enrolled,
    last_activity_type: result.last_activity_type,
    current_event_learning_unit: result.current_event_learning_unit,
  });
}

export const eventHandlers = { enroll, isEnrolled };