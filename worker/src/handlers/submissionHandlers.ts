/**
 * handlers/submissionHandlers.ts
 * requestUpload mints submission_id+object_key and signs a GCS upload URL;
 * accepts an OPTIONAL idempotency_key so a double-tap "take photo" dedupes
 * instead of burning two attempt slots. submitArtwork takes object_key
 * (not a raw submission URL): parses it, re-derives the expected key from
 * server-known values, confirms the object exists on GCS (existence →
 * size → content-type), then calls Frappe with object_key. Neither route
 * ever echoes back a submission_id/object_key identifier in the artwork
 * response — a client reads a submission's id from /progress/sync or
 * /progress/last_submission instead.
 *
 * This file was already correctly wired to `analytics` (5th param) and
 * routePath in enforceRateLimit/noteFrappeCall/noteIdempotencyRepeat —
 * kept unchanged from the version that was actually correct; included
 * here in full so the whole handler set is consistent in one place.
 */

import { requireStudentToken } from "../auth/middleware";
import { fetchFrappe } from "../frappe/client";
import { FRAPPE_METHODS } from "../frappe/mapRequest";
import type { Env, ActivityContext } from "../env";
import {
  invalidInput,
  parseActivityContext,
  uploadNotConfirmed,
  uploadSizeInvalid,
  uploadTypeMismatch,
} from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { withIdempotency } from "../cache/idempotency";
import { isValidIdempotencyKey } from "../util/ids";
import { collectTelemetry } from "../telemetry/collector";
import { config } from "../config/index";
import { signSubmission, type RawSubmission } from "../storage/resign";
import {
  FIELD_PATTERNS,
  buildObjectKey,
  mintSubmissionId,
  parseObjectKey,
  assertObjectKeyMatches,
  resolveAcceptedFormat,
  findAcceptedFormatByExt,
  type SubmissionType,
} from "../storage/keys";
import { gcsSignUpload, confirmUploaded } from "../storage/gcs";
import type { RequestAnalyticsContext } from "../router";

const SUBMISSION_TYPES: readonly SubmissionType[] = ["image", "video"] as const;

function parseSubmissionType(raw: unknown): SubmissionType {
  if (raw === "image" || raw === "video") return raw;
  throw invalidInput(`submission_type missing or invalid (must be one of: ${SUBMISSION_TYPES.join(", ")})`);
}

interface RequestUploadBody {
  assignment_id?: string;
  submission_type?: unknown;
  format?: unknown;
  context?: unknown;
  idempotency_key?: string;
  _t?: unknown;
}

interface CheckAttemptCapResult {
  attempt_number: number;
  attempts_remaining: number;
}

interface RequestUploadResult {
  upload_url: string;
  object_key: string;
  content_type: string;
  upload_headers: Record<string, string>;
  expires_in: number;
  max_size_bytes: number;
  attempt_number: number;
  attempts_remaining: number;
  context: ActivityContext;
}

const ROUTE_REQUEST_UPLOAD = "/submission/request_upload";
const ROUTE_SUBMIT_ARTWORK = "/submission/submit_artwork";
const ROUTE_LIST = "/submission/list";
const ROUTE_GET = "/submission/get";

async function requestUpload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_REQUEST_UPLOAD, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as RequestUploadBody;

  if (!body.assignment_id || !FIELD_PATTERNS.assignment_id.test(body.assignment_id)) {
    throw invalidInput("assignment_id missing or malformed");
  }

  const submissionType = parseSubmissionType(body.submission_type);
  const format = resolveAcceptedFormat(submissionType, body.format);
  const activityContext: ActivityContext = parseActivityContext(body.context, cfg.DEFAULT_SUBMISSION_CONTEXT);

  const doRequestUpload = async (): Promise<RequestUploadResult> => {
    const cap = await fetchFrappe<CheckAttemptCapResult>(env, FRAPPE_METHODS.checkAttemptCap, {
      student_id: studentId,
      assignment_id: body.assignment_id,
      context: activityContext,
    });
    analytics.noteFrappeCall(FRAPPE_METHODS.checkAttemptCap);

    const submissionId = mintSubmissionId(cfg.ID_RANDOM_CHARS);
    const objectKey = buildObjectKey({
      assignmentId: body.assignment_id as string,
      studentId,
      submissionId,
      attempt: cap.attempt_number,
      ext: format.ext,
    });

    const signed = await gcsSignUpload(env, objectKey, submissionType, format.contentType, cfg);

    return {
      upload_url: signed.uploadUrl,
      object_key: objectKey,
      content_type: signed.contentType,
      upload_headers: signed.uploadHeaders,
      expires_in: signed.expiresIn,
      max_size_bytes: signed.maxSizeBytes,
      attempt_number: cap.attempt_number,
      attempts_remaining: cap.attempts_remaining,
      context: activityContext,
    };
  };

  let result: RequestUploadResult;
  let repeat = false;

  if (isValidIdempotencyKey(body.idempotency_key)) {
    const idem = await withIdempotency<RequestUploadResult>(
      "request_upload",
      studentId,
      body.idempotency_key as string,
      cfg.IDEMPOTENCY_TTL_BY_ROUTE.request_upload ?? cfg.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
      doRequestUpload
    );
    result = idem.result;
    repeat = idem.repeat;
    analytics.noteIdempotencyRepeat(repeat);
  } else {
    result = await doRequestUpload();
  }

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({ ...result, repeat });
}

interface SubmitArtworkBody {
  assignment_id?: string;
  object_key?: string;
  idempotency_key?: string;
  context?: unknown;
  _t?: unknown;
}

interface SubmitArtworkFrappeResult {
  status: string;
  created_at: string;
  assignment_id_link: string;
  attempt_number: number;
  attempts_remaining: number;
  points_awarded?: number;
  points_total?: number;
  updated_at: number;
}

async function submitArtwork(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "write", ROUTE_SUBMIT_ARTWORK, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as SubmitArtworkBody;

  if (!body.assignment_id) throw invalidInput("assignment_id missing");
  if (!body.object_key || typeof body.object_key !== "string") throw invalidInput("object_key missing");
  if (!isValidIdempotencyKey(body.idempotency_key)) throw invalidInput("idempotency_key missing or invalid");

  const assignmentId = body.assignment_id;
  const objectKey = body.object_key;
  const idempotencyKey = body.idempotency_key as string;
  const activityContext: ActivityContext = parseActivityContext(body.context, cfg.DEFAULT_SUBMISSION_CONTEXT);

  const parsed = parseObjectKey(objectKey);
  assertObjectKeyMatches(objectKey, {
    assignmentId,
    studentId,
    submissionId: parsed.submissionId,
    attempt: parsed.attempt,
    ext: parsed.ext,
  });

  const matchedImage = findAcceptedFormatByExt("image", parsed.ext);
  const matchedVideo = findAcceptedFormatByExt("video", parsed.ext);
  const matchedFormat = matchedImage ?? matchedVideo;
  const submissionType: SubmissionType | null = matchedImage ? "image" : matchedVideo ? "video" : null;
  if (!matchedFormat || !submissionType) {
    throw invalidInput("object_key's file extension is not an accepted upload format");
  }

  const confirmation = await confirmUploaded(env, objectKey);
  if (!confirmation.exists) {
    throw uploadNotConfirmed("the uploaded file could not be found at the expected object_key");
  }

  const maxSizeBytes = submissionType === "image" ? cfg.UPLOAD_MAX_BYTES_IMAGE : cfg.UPLOAD_MAX_BYTES_VIDEO;
  if (confirmation.sizeBytes === null || confirmation.sizeBytes <= 0 || confirmation.sizeBytes > maxSizeBytes) {
    throw uploadSizeInvalid(
      `uploaded file size (${confirmation.sizeBytes ?? "unknown"} bytes) is out of bounds for submission_type "${submissionType}" (max ${maxSizeBytes} bytes)`
    );
  }

  if (confirmation.contentType !== matchedFormat.contentType) {
    throw uploadTypeMismatch(
      `uploaded file content type "${confirmation.contentType ?? "unknown"}" does not match the expected "${matchedFormat.contentType}" for object_key's extension`
    );
  }

  const { result, repeat } = await withIdempotency(
    "submit_artwork",
    studentId,
    idempotencyKey,
    cfg.IDEMPOTENCY_TTL_BY_ROUTE.submit_artwork ?? cfg.DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    async () => {
      const frappeResult = await fetchFrappe<SubmitArtworkFrappeResult>(env, FRAPPE_METHODS.submitArtwork, {
        assignment_id: assignmentId,
        student_id: studentId,
        object_key: objectKey,
        idempotency_key: idempotencyKey,
        context: activityContext,
      });
      analytics.noteFrappeCall(FRAPPE_METHODS.submitArtwork);

      return {
        status: frappeResult.status,
        created_at: frappeResult.created_at,
        assignment_id_link: frappeResult.assignment_id_link,
        attempt_number: frappeResult.attempt_number,
        attempts_remaining: frappeResult.attempts_remaining,
        points_awarded: frappeResult.points_awarded,
        points_total: frappeResult.points_total,
        context: activityContext,
        updated_at: frappeResult.updated_at,
      };
    }
  );
  analytics.noteIdempotencyRepeat(repeat);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({ ...result, repeat });
}

interface ListBody { _t?: unknown; }
interface ListFrappeResult {
  submissions: RawSubmission[];
  count: number;
  total_count: number;
  has_more: boolean;
}

async function list(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "read", ROUTE_LIST, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as ListBody;

  const result = await fetchFrappe<ListFrappeResult>(env, FRAPPE_METHODS.listSubmissions, { student_id: studentId });
  analytics.noteFrappeCall(FRAPPE_METHODS.listSubmissions);

  const signed = await Promise.all(result.submissions.map((s) => signSubmission(env, s, cfg)));

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({ submissions: signed, count: result.count, total_count: result.total_count, has_more: result.has_more });
}

interface GetBody { submission_id?: string; context?: unknown; _t?: unknown; }

async function get(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "read", ROUTE_GET, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const body = (await req.json().catch(() => ({}))) as GetBody;
  if (!body.submission_id) throw invalidInput("submission_id missing");

  const activityContext: ActivityContext | undefined =
    body.context === undefined || body.context === null || body.context === ""
      ? undefined
      : parseActivityContext(body.context, cfg.DEFAULT_SUBMISSION_CONTEXT);

  const result = await fetchFrappe<RawSubmission>(env, FRAPPE_METHODS.getSubmission, {
    student_id: studentId,
    submission_id: body.submission_id,
    ...(activityContext ? { context: activityContext } : {}),
  });
  analytics.noteFrappeCall(FRAPPE_METHODS.getSubmission);

  const signed = await signSubmission(env, result, cfg);

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({ ...signed });
}

export const submissionHandlers = { requestUpload, submitArtwork, list, get };