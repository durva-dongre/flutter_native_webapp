/**
 * handlers/progressHandlers.ts
 * Worker-side wrappers for submit_video_watched / submit_quiz / sync /
 * last_submission. Frappe's own `repeat` for video/quiz is OR'd with the
 * Worker's own idempotency-cache repeat, so a fresh idempotency key for an
 * activity Frappe already recorded correctly reports repeat: true instead
 * of a contradictory points_awarded: 0, repeat: false.
 *
 * FIX: every handler now takes `analytics` and passes it + its own route
 * path into enforceRateLimit, and calls analytics.noteFrappeCall around
 * every Frappe call — closes the same router/handler wiring gap as every
 * other file in this batch.
 */

import { requireStudentToken } from "../auth/middleware";
import { fetchFrappe } from "../frappe/client";
import { FRAPPE_METHODS } from "../frappe/mapRequest";
import type { Env, ActivityContext } from "../env";
import { invalidInput, parseActivityContext } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { withIdempotency } from "../cache/idempotency";
import { isValidIdempotencyKey } from "../util/ids";
import { collectTelemetry } from "../telemetry/collector";
import { signSubmission, type RawSubmission } from "../storage/resign";
import { config } from "../config/index";
import { tierInfo } from "../constants/pointTiers";
import type { RequestAnalyticsContext } from "../router";

const SELECTED_KEY_PATTERN = /^[1-9][0-9]*$/;

const ROUTE_SUBMIT_VIDEO = "/progress/submit_video_watched";
const ROUTE_SUBMIT_QUIZ = "/progress/submit_quiz";
const ROUTE_SYNC = "/progress/sync";
const ROUTE_LAST_SUBMISSION = "/progress/last_submission";

interface SubmitVideoBody {
  unit_id?: string;
  video_id?: string;
  watched?: boolean;
  idempotency_key?: string;
  context?: unknown;
  _t?: unknown;
}
interface SubmitVideoFrappeResult {
  points_awarded: number;
  points_total: number;
  updated_at: number;
  repeat?: boolean;
  unit_completed?: boolean;
  course_completed?: boolean;
  next_learning_unit_id?: string | null;
}

async function submitVideoWatched(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_SUBMIT_VIDEO, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as SubmitVideoBody;
  if (!body.unit_id) throw invalidInput("unit_id missing");
  if (!body.video_id || typeof body.video_id !== "string") throw invalidInput("video_id missing");
  if (typeof body.watched !== "boolean") throw invalidInput("watched missing or not boolean");
  if (!isValidIdempotencyKey(body.idempotency_key)) throw invalidInput("idempotency_key missing or invalid");

  const activityContext: ActivityContext = parseActivityContext(body.context, cfg.DEFAULT_SUBMISSION_CONTEXT);

  const { result, repeat } = await withIdempotency(
    "submit_video_watched",
    studentId,
    body.idempotency_key,
    cfg.IDEMPOTENCY_TTL_BY_ROUTE.submit_video_watched ?? cfg.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    async () => {
      const r = await fetchFrappe<SubmitVideoFrappeResult>(env, FRAPPE_METHODS.submitVideoWatched, {
        student_id: studentId,
        unit_id: body.unit_id,
        video_id: body.video_id,
        watched: body.watched,
        context: activityContext,
      });
      analytics.noteFrappeCall(FRAPPE_METHODS.submitVideoWatched);
      return r;
    }
  );
  analytics.noteIdempotencyRepeat(repeat);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  const tier = tierInfo(result.points_total);
  const data: Record<string, unknown> = {
    points_awarded: result.points_awarded,
    points_total: result.points_total,
    points_tier: tier.points_tier,
    context: activityContext,
    repeat: repeat || result.repeat === true,
    updated_at: result.updated_at,
  };
  if (result.unit_completed !== undefined) data.unit_completed = result.unit_completed;
  if (result.course_completed !== undefined) data.course_completed = result.course_completed;
  if (result.next_learning_unit_id !== undefined) data.next_learning_unit_id = result.next_learning_unit_id;

  return ok(data);
}

interface SubmitQuizBody {
  unit_id?: string;
  quiz_id?: string;
  answers?: Array<{ question_id: string; selected_key: string }>;
  idempotency_key?: string;
  context?: unknown;
  _t?: unknown;
}
interface SubmitQuizFrappeResult {
  quiz_id: string;
  correct_count: number;
  total_count: number;
  points_awarded: number;
  points_total: number;
  updated_at: number;
  repeat?: boolean;
  unit_completed?: boolean;
  course_completed?: boolean;
  next_learning_unit_id?: string | null;
}

async function submitQuiz(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_SUBMIT_QUIZ, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as SubmitQuizBody;
  if (!body.unit_id) throw invalidInput("unit_id missing");
  if (!body.quiz_id || typeof body.quiz_id !== "string") throw invalidInput("quiz_id missing");
  if (!Array.isArray(body.answers) || body.answers.length === 0) throw invalidInput("answers missing or empty");
  for (const a of body.answers) {
    if (!a.question_id || typeof a.selected_key !== "string" || !SELECTED_KEY_PATTERN.test(a.selected_key)) {
      throw invalidInput('each answer needs a question_id and a numeric selected_key (e.g. "1", "2", "3")');
    }
  }
  if (!isValidIdempotencyKey(body.idempotency_key)) throw invalidInput("idempotency_key missing or invalid");

  const activityContext: ActivityContext = parseActivityContext(body.context, cfg.DEFAULT_SUBMISSION_CONTEXT);

  const { result, repeat } = await withIdempotency(
    "submit_quiz",
    studentId,
    body.idempotency_key,
    cfg.IDEMPOTENCY_TTL_BY_ROUTE.submit_quiz ?? cfg.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    async () => {
      const r = await fetchFrappe<SubmitQuizFrappeResult>(env, FRAPPE_METHODS.submitQuiz, {
        student_id: studentId,
        unit_id: body.unit_id,
        quiz_id: body.quiz_id,
        answers: body.answers,
        context: activityContext,
      });
      analytics.noteFrappeCall(FRAPPE_METHODS.submitQuiz);
      return r;
    }
  );
  analytics.noteIdempotencyRepeat(repeat);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  const tier = tierInfo(result.points_total);
  const data: Record<string, unknown> = {
    quiz_id: result.quiz_id,
    correct_count: result.correct_count,
    total_count: result.total_count,
    points_awarded: result.points_awarded,
    points_total: result.points_total,
    points_tier: tier.points_tier,
    context: activityContext,
    repeat: repeat || result.repeat === true,
    updated_at: result.updated_at,
  };
  if (result.unit_completed !== undefined) data.unit_completed = result.unit_completed;
  if (result.course_completed !== undefined) data.course_completed = result.course_completed;
  if (result.next_learning_unit_id !== undefined) data.next_learning_unit_id = result.next_learning_unit_id;

  return ok(data);
}

interface SyncBody { last_updated?: number | null; _t?: unknown; }
interface SyncFrappeResult {
  changed: boolean;
  updated_at: number;
  points?: number;
  gems?: number;
  current_learning_unit?: string | null;
  last_activity_type?: string | null;
  last_submission?: RawSubmission | null;
  status?: string;
  course_completed?: boolean;
  last_completed_unit?: string | null;
}

async function sync(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "read", ROUTE_SYNC, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as SyncBody;

  let lastUpdated: number;
  if (body.last_updated === undefined || body.last_updated === null) {
    lastUpdated = 0;
  } else if (typeof body.last_updated === "number" && Number.isInteger(body.last_updated)) {
    lastUpdated = body.last_updated;
  } else {
    throw invalidInput("last_updated must be an integer, null, or omitted");
  }

  const result = await fetchFrappe<SyncFrappeResult>(env, FRAPPE_METHODS.progressSync, {
    student_id: studentId,
    last_updated: lastUpdated,
  });
  analytics.noteFrappeCall(FRAPPE_METHODS.progressSync);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  const data: Record<string, unknown> = { changed: result.changed, updated_at: result.updated_at };

  if (result.status !== undefined) data.status = result.status;

  if (result.changed) {
    data.points = result.points;
    if (typeof result.points === "number") {
      const tier = tierInfo(result.points);
      data.points_tier = tier.points_tier;
    }
    data.gems = result.gems;
    data.current_learning_unit = result.current_learning_unit;
    data.last_activity_type = result.last_activity_type;

    if (result.course_completed !== undefined) data.course_completed = result.course_completed;
    if (result.last_completed_unit !== undefined) data.last_completed_unit = result.last_completed_unit;

    if (result.last_submission) {
      data.last_submission = await signSubmission(env, result.last_submission, cfg);
    }
  }

  return ok(data);
}

interface LastSubmissionBody { last_updated?: number | null; _t?: unknown; }
interface LastSubmissionFrappeResult {
  has_update: boolean;
  points: number;
  gems: number;
  last_submission?: RawSubmission | null;
}

async function lastSubmission(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "read", ROUTE_LAST_SUBMISSION, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as LastSubmissionBody;

  let lastUpdated: number;
  if (body.last_updated === undefined || body.last_updated === null) {
    lastUpdated = 0;
  } else if (typeof body.last_updated === "number" && Number.isInteger(body.last_updated)) {
    lastUpdated = body.last_updated;
  } else {
    throw invalidInput("last_updated must be an integer, null, or omitted");
  }

  const result = await fetchFrappe<LastSubmissionFrappeResult>(env, FRAPPE_METHODS.lastSubmission, {
    student_id: studentId,
    last_updated: lastUpdated,
  });
  analytics.noteFrappeCall(FRAPPE_METHODS.lastSubmission);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  const tier = tierInfo(result.points);
  const data: Record<string, unknown> = {
    has_update: result.has_update,
    points: result.points,
    points_tier: tier.points_tier,
    gems: result.gems,
  };
  if (result.has_update && result.last_submission) {
    data.last_submission = await signSubmission(env, result.last_submission, cfg);
  }

  return ok(data);
}

export const progressHandlers = { submitVideoWatched, submitQuiz, sync, lastSubmission };