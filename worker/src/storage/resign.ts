/**
 * storage/resign.ts — resolves a submission's stored media references into
 * client-usable URLs. A submission's graded result is always returned as
 * `points`, never `score`/`grade`. attempts_remaining is present on every row.
 *
 * status/result_status match the Submission doctype's Select options exactly.
 * "Success - Flagged" is a completed/scored submission, not a failure — it
 * just never earns the grading bonus.
 *
 * unit_completed / course_completed / next_learning_unit_id / unit_status / context
 * are forwarded unchanged from Frappe whenever present — absent means unchanged.
 *
 * v9 fix -- context field added: Frappe's _submission_wire_shape (tap_app/api/
 * submission.py) and shared/profile/sync.py's _build_submission_block both include
 * a "context" ("program" | "event") field on every submission-shaped response
 * (list/get/sync/last_submission), but RawSubmission/SignedSubmission never declared
 * it, so it was silently dropped by signSubmission before reaching the client. Both
 * interfaces now declare `context`, and both return branches of signSubmission below
 * forward it through unchanged.
 */

import type { Env } from "../env";
import type { ConfigSchema } from "../config/defaults";
import { gcsSignRead } from "./gcs";
import { buildMediaUrl } from "./r2";

export type SubmissionStatus = "Pending" | "Processing" | "Completed" | "Failed";
export const SUBMISSION_STATUS_OPTIONS: readonly SubmissionStatus[] = [
  "Pending",
  "Processing",
  "Completed",
  "Failed",
] as const;

export type ResultStatus = "Pending" | "Success - Original" | "Success - Flagged" | "Failed";
export const RESULT_STATUS_OPTIONS: readonly ResultStatus[] = [
  "Pending",
  "Success - Original",
  "Success - Flagged",
  "Failed",
] as const;

export type UnitStatus = "Not Started" | "In Progress" | "Completed" | "Stopped";

export interface RawSubmission {
  /** Canonical identifier — matches Frappe's `submission_id` key on every
   *  submission-shaped payload. */
  submission_id?: string;
  assignment_id_link: string;
  status: SubmissionStatus;
  result_status?: ResultStatus;
  view_url?: string | null;
  object_key?: string;
  media_location?: "gcs" | "r2";
  overall_feedback_audio_url?: string | null;
  feedback_audio_key?: string | null;
  feedback_audio_location?: "gcs" | "r2" | null;
  points?: number;
  overall_feedback_translated?: string;
  points_awarded?: number;
  gems_awarded?: number;
  unit_completed?: boolean;
  course_completed?: boolean;
  next_learning_unit_id?: string | null;
  unit_status?: UnitStatus;
  /** Which track this submission belongs to -- "program" | "event". Sent by Frappe
   *  on every submission-shaped response (list/get/sync/last_submission) via
   *  _submission_wire_shape / _build_submission_block. */
  context?: "program" | "event";
  attempt_number: number;
  attempts_remaining: number;
  created_at?: string;
  updated_at: number;
}

export interface SignedSubmission {
  submission_id?: string;
  assignment_id_link: string;
  status: SubmissionStatus;
  result_status?: ResultStatus;
  view_url?: string;
  points?: number;
  overall_feedback_translated?: string;
  overall_feedback_audio_url?: string;
  points_awarded?: number;
  gems_awarded?: number;
  unit_completed?: boolean;
  course_completed?: boolean;
  next_learning_unit_id?: string | null;
  unit_status?: UnitStatus;
  context?: "program" | "event";
  attempt_number: number;
  attempts_remaining: number;
  created_at?: string;
  updated_at: number;
}

const GCS_URL_PREFIX = "https://storage.googleapis.com/";

/** "Null"/"none"/empty are sentinels used throughout the feedback pipeline
 *  for "no audio yet" — not a real url. */
function isRealUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.toLowerCase() !== "null" && trimmed.toLowerCase() !== "none";
}

/**
 * Parses ANY "https://storage.googleapis.com/{bucket}/{key...}" url, whatever
 * bucket it names — no allowlist. Mirrors
 * tap_lms/shared/submission/object_naming.py::extract_gcs_bucket_and_key
 * exactly, so both sides agree on what counts as a well-formed GCS object URL.
 */
function parseGcsUrl(url: string): { bucket: string; key: string } | null {
  if (!url.startsWith(GCS_URL_PREFIX)) return null;
  const rest = url.slice(GCS_URL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const keyWithQuery = rest.slice(slash + 1);
  const key = keyWithQuery.split("?")[0];
  if (!bucket || !key) return null;
  return { bucket, key: decodeURIComponent(key) };
}

/**
 * Resolves a stored media url to what the app should actually fetch: a
 * freshly signed, time-limited GET url when it's recognizably a GCS object
 * (whichever bucket it's in), or the url passed straight through unchanged
 * when it isn't a GCS url at all (e.g. an R2 public url, or some other
 * already-usable link).
 *
 * A url that IS a GCS object but fails to sign returns `undefined` rather
 * than the raw, unsigned GCS url — an unsigned storage.googleapis.com link
 * 403s for any non-public object, so handing it back "as a fallback" would
 * just defer a guaranteed failure to the client with no diagnostic trail.
 * The failure is logged here instead, and the field is omitted from the
 * response (ok()'s stripUndefined drops it), which is both honest to the
 * client and visible in the Worker's own logs.
 */
async function resolveMediaUrl(
  env: Env,
  cfg: Pick<ConfigSchema, "PRESIGN_EXPIRY_SECONDS">,
  url: string | null | undefined
): Promise<string | undefined> {
  if (!isRealUrl(url)) return undefined;

  const parsed = parseGcsUrl(url);
  if (!parsed) {
    return url;
  }

  try {
    return await gcsSignRead(env, parsed.bucket, parsed.key, cfg.PRESIGN_EXPIRY_SECONDS);
  } catch (err) {
    console.error(`[resign] gcsSignRead failed for gs://${parsed.bucket}/${parsed.key}`, err);
    return undefined;
  }
}

/** Alternate-input path: a bare object_key + media_location, for a caller
 *  that has one instead of a full url. A "gcs" location signs against the
 *  Worker's own primary bucket (GCS_AUTHENTICATED_BUCKET) since there is no
 *  bucket name to parse here. Propagates a sign failure the same way
 *  resolveMediaUrl does — returns undefined rather than an unusable url. */
async function resolveFromKeyFields(
  env: Env,
  cfg: Pick<ConfigSchema, "MEDIA_MODE_OWN" | "PRESIGN_WINDOW_SECONDS" | "PRESIGN_EXPIRY_SECONDS">,
  objectKey: string | null | undefined,
  location: "gcs" | "r2" | null | undefined
): Promise<string | undefined> {
  if (!objectKey || !location) return undefined;
  if (location === "r2") return buildMediaUrl(objectKey, cfg.MEDIA_MODE_OWN, env, cfg);
  try {
    return await gcsSignRead(env, env.GCS_AUTHENTICATED_BUCKET, objectKey, cfg.PRESIGN_EXPIRY_SECONDS);
  } catch (err) {
    console.error(`[resign] gcsSignRead failed for key ${objectKey}`, err);
    return undefined;
  }
}

export async function signSubmission(
  env: Env,
  raw: RawSubmission,
  cfg: Pick<ConfigSchema, "MEDIA_MODE_OWN" | "PRESIGN_WINDOW_SECONDS" | "PRESIGN_EXPIRY_SECONDS">
): Promise<SignedSubmission> {
  // feedback_audio_key alone is not sufficient to resolve audio — it must be
  // paired with feedback_audio_location, the same way object_key is paired
  // with media_location just above it. Gating on the key alone here would
  // trigger the "has media" branch below even when resolveFromKeyFields will
  // immediately return undefined for lack of a location.
  const hasAnyMedia =
    isRealUrl(raw.view_url) ||
    isRealUrl(raw.overall_feedback_audio_url) ||
    !!(raw.object_key && raw.media_location) ||
    !!(raw.feedback_audio_key && raw.feedback_audio_location);

  if (!hasAnyMedia) {
    return {
      submission_id: raw.submission_id,
      assignment_id_link: raw.assignment_id_link,
      status: raw.status,
      result_status: raw.result_status,
      points_awarded: raw.points_awarded,
      gems_awarded: raw.gems_awarded,
      unit_completed: raw.unit_completed,
      course_completed: raw.course_completed,
      next_learning_unit_id: raw.next_learning_unit_id,
      unit_status: raw.unit_status,
      context: raw.context,
      attempt_number: raw.attempt_number,
      attempts_remaining: raw.attempts_remaining,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    };
  }

  const [viewUrl, audioUrl] = await Promise.all([
    isRealUrl(raw.view_url)
      ? resolveMediaUrl(env, cfg, raw.view_url)
      : resolveFromKeyFields(env, cfg, raw.object_key, raw.media_location),
    isRealUrl(raw.overall_feedback_audio_url)
      ? resolveMediaUrl(env, cfg, raw.overall_feedback_audio_url)
      : resolveFromKeyFields(env, cfg, raw.feedback_audio_key, raw.feedback_audio_location),
  ]);

  return {
    submission_id: raw.submission_id,
    assignment_id_link: raw.assignment_id_link,
    status: raw.status,
    result_status: raw.result_status,
    view_url: viewUrl,
    points: raw.points,
    overall_feedback_translated: raw.overall_feedback_translated,
    overall_feedback_audio_url: audioUrl,
    points_awarded: raw.points_awarded,
    gems_awarded: raw.gems_awarded,
    unit_completed: raw.unit_completed,
    course_completed: raw.course_completed,
    next_learning_unit_id: raw.next_learning_unit_id,
    unit_status: raw.unit_status,
    context: raw.context,
    attempt_number: raw.attempt_number,
    attempts_remaining: raw.attempts_remaining,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}