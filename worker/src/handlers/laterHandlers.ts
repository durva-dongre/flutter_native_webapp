/**
 * handlers/laterHandlers.ts
 * do_later is a pure no-op: nothing is written to D1 or Frappe, the
 * assignment's progress just stays blank (= not done). context is echoed
 * back purely for the app's own bookkeeping — it never gates anything.
 *
 * FIX: analytics threaded through and passed into enforceRateLimit with
 * this route's path, matching every other write route.
 */

import { requireStudentToken } from "../auth/middleware";
import type { Env, ActivityContext } from "../env";
import { invalidInput, parseActivityContext } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { FIELD_PATTERNS } from "../storage/keys";
import { collectTelemetry } from "../telemetry/collector";
import { config } from "../config/index";
import type { RequestAnalyticsContext } from "../router";

const ROUTE_DO_LATER = "/submission/do_later";

interface DoLaterBody { assignment_id?: string; context?: unknown; _t?: unknown; }

async function doLater(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_DO_LATER, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as DoLaterBody;
  if (!body.assignment_id || !FIELD_PATTERNS.assignment_id.test(body.assignment_id)) {
    throw invalidInput("assignment_id missing or malformed");
  }

  const activityContext: ActivityContext = parseActivityContext(body.context, cfg.DEFAULT_SUBMISSION_CONTEXT);

  // Nothing else happens here — no D1 row, no Frappe call, no token minting.
  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({ assignment_id: body.assignment_id, context: activityContext, status: "later" });
}

export const laterHandlers = { doLater };