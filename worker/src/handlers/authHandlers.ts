/**
 * handlers/authHandlers.ts
 * /auth/redeem mints a phone token (fallback only) + a student token per
 * sibling, embedded inline in each student's own resume payload. There is
 * no top-level `token`. /auth/select_profile re-derives one student token
 * from a still-valid phone token when the app's cached student token is
 * gone. Tokens are fixed-TTL and never refreshed by any call.
 *
 * FIX: every handler now takes `analytics` (5th param) and passes it +
 * this route's own path into enforceRateLimit, so TURN_BUDGETS are
 * actually checked and frappeMethodCalled/rateLimitRemaining stop being
 * permanently null in Analytics Engine (see router.ts for why this was
 * previously silently dropped).
 */

import { checkBurst } from "../cache/rateLimitCache";
import { fetchFrappe } from "../frappe/client";
import { FRAPPE_METHODS } from "../frappe/mapRequest";
import { verifyMagicLinkV2, formatDest } from "../auth/magicLink";
import { mintPhoneToken, mintStudentToken } from "../auth/sessionToken";
import { requirePhoneToken } from "../auth/middleware";
import type { Env } from "../env";
import { invalidInput, rateLimited, studentNotFound } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { collectTelemetry } from "../telemetry/collector";
import { tierInfo } from "../constants/pointTiers";
import { config } from "../config/index";
import type { RequestAnalyticsContext } from "../router";

interface RedeemBody { code?: string; _t?: unknown; }
interface SelectProfileBody { student_id?: string; _t?: unknown; }

export type LastActivityType = "video" | "quiz" | "submission" | null;

interface ProfileResumeFields {
  student_id: string;
  name: string;
  grade: string;
  points: number;
  gems: number;
  current_learning_unit: string | null;
  last_activity_type: LastActivityType;
  state_id: string;
  district_id: string;
  school_id: string;
  state_name: string;
  district_name: string;
  school_name: string;
  course_id: string;
  language: string;
  updated_at: number;
  status?: string;
  course_completed?: boolean;
  last_completed_unit?: string | null;
}

interface RedeemMagicLinkResult {
  students: ProfileResumeFields[];
}

// Route paths kept as constants so analytics/turn-budget keys stay exact.
const ROUTE_REDEEM = "/auth/redeem";
const ROUTE_SELECT_PROFILE = "/auth/select_profile";

// Builds one student's wire payload with its own token embedded inline.
// No current_event_learning_unit here ever — event resume state lives
// only behind /events/is_enrolled.
function resumePayload(r: ProfileResumeFields, studentToken: string): Record<string, unknown> {
  const tier = tierInfo(r.points);
  return {
    student_id: r.student_id,
    token: studentToken,
    name: r.name,
    grade: r.grade,
    points: r.points,
    points_tier: tier.points_tier,
    gems: r.gems,
    current_learning_unit: r.current_learning_unit,
    last_activity_type: r.last_activity_type,
    state_id: r.state_id,
    district_id: r.district_id,
    school_id: r.school_id,
    state_name: r.state_name,
    district_name: r.district_name,
    school_name: r.school_name,
    course_id: r.course_id,
    language: r.language,
    updated_at: r.updated_at,
    status: r.status,
    course_completed: r.course_completed,
    last_completed_unit: r.last_completed_unit,
  };
}

async function redeem(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipBurst = await checkBurst(`ip:${ip}`, "auth", cfg.RATE_LIMITS);
  if (!ipBurst.allowed) throw rateLimited("too many redeem attempts from this network");

  const body = (await req.json().catch(() => ({}))) as RedeemBody;
  if (!body.code || typeof body.code !== "string") throw invalidInput("code missing");

  // Pure stateless verify — no "used" check, redeeming never consumes the link.
  const payload = await verifyMagicLinkV2(env.MAGIC_LINK_SECRET, body.code);

  const phoneBurst = await checkBurst(`phone:${payload.phone}`, "auth", cfg.RATE_LIMITS);
  if (!phoneBurst.allowed) throw rateLimited("too many redeem attempts for this phone");

  // No studentId exists yet pre-auth; key turn-budget identity on the phone
  // instead so the route still gets a real budget/analytics signal.
  await enforceRateLimit(env, `phone:${payload.phone}`, "auth", ROUTE_REDEEM, analytics);

  const frappeResult = await fetchFrappe<RedeemMagicLinkResult>(env, FRAPPE_METHODS.redeemMagicLink, {
    phone: payload.phone,
  });
  analytics.noteFrappeCall(FRAPPE_METHODS.redeemMagicLink);

  if (!frappeResult.students || frappeResult.students.length === 0) {
    throw studentNotFound("no student with an active enrollment for this phone");
  }

  const defaultStudent = frappeResult.students[0] as ProfileResumeFields;

  const [phoneToken, studentTokens] = await Promise.all([
    mintPhoneToken(payload.phone, env, cfg.PHONE_TOKEN_TTL_SECONDS),
    Promise.all(frappeResult.students.map((s) => mintStudentToken(s.student_id, env, cfg.STUDENT_TOKEN_TTL_SECONDS))),
  ]);

  setStudentId(defaultStudent.student_id);

  const responseData: Record<string, unknown> = {
    phone_token: phoneToken,
    active_student_id: defaultStudent.student_id,
    students: frappeResult.students.map((s, i) => resumePayload(s, studentTokens[i] as string)),
  };
  if (payload.dest) responseData.dest = formatDest(payload.dest);

  ctx.waitUntil(collectTelemetry(env, defaultStudent.student_id, body._t).catch(() => {}));

  return ok(responseData);
}

async function selectProfile(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const { phone } = await requirePhoneToken(req, env);

  const body = (await req.json().catch(() => ({}))) as SelectProfileBody;
  if (!body.student_id || typeof body.student_id !== "string") throw invalidInput("student_id missing");

  await enforceRateLimit(env, body.student_id, "auth", ROUTE_SELECT_PROFILE, analytics);

  const resume = await fetchFrappe<ProfileResumeFields>(env, FRAPPE_METHODS.selectProfile, {
    phone,
    student_id: body.student_id,
  });
  analytics.noteFrappeCall(FRAPPE_METHODS.selectProfile);

  const token = await mintStudentToken(resume.student_id, env, cfg.STUDENT_TOKEN_TTL_SECONDS);
  setStudentId(resume.student_id);

  ctx.waitUntil(collectTelemetry(env, resume.student_id, body._t).catch(() => {}));

  return ok({ active_student_id: resume.student_id, ...resumePayload(resume, token) });
}

export const authHandlers = { redeem, selectProfile };