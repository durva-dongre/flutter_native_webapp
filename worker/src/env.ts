/**
 * env.ts  
 *
 * What changed: AppError now carries an optional `subCode` -- Frappe's own
 * error_code, preserved as a distinguishable sub-code instead of being
 * discarded or jammed into the `message` field. `forbidden` (403) is now its
 * own error factory/code, separate from `unauthorized` (401) -- both are real,
 * permanent, non-retryable failures and must never be mapped to a "safe to
 * retry" code (that fix lives in frappe/client.ts; this file just adds the
 * pieces it needs).
 */

export interface Env {
  DB: D1Database;

  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_SUBMISSIONS_BUCKET_NAME: string;

  MAGIC_LINK_SECRET: string;
  PHONE_TOKEN_SECRET: string;
  STUDENT_TOKEN_SECRET: string;
  GALLERY_SCOPE_TOKEN_SECRET: string;
  INTERNAL_API_SECRET: string;

  FRAPPE_BASE_URL: string;
  FRAPPE_API_KEY: string;
  FRAPPE_API_SECRET: string;

  GCS_SERVICE_ACCOUNT_JSON: string;
  GCS_AUTHENTICATED_BUCKET: string;

  AI_PROVIDER_API_KEY: string;
  AI_PROVIDER_BASE_URL: string;
  AI_PROVIDER_MODEL: string;

  BQ_SERVICE_ACCOUNT_JSON: string;
  BQ_PROJECT_ID: string;
  BQ_DATASET: string;
  BQ_ENABLED?: string;

  GALLERY_FALLBACK_ENABLED?: string;
  GALLERY_FALLBACK_CASCADE?: string;
  GALLERY_SORT?: string;
  GALLERY_PAGE_DEFAULT?: string;
  GALLERY_PAGE_MAX?: string;
  GALLERY_PAGE_CACHE_SECONDS?: string;
  GALLERY_ROW_CACHE_SECONDS?: string;
  GALLERY_SHOW_NAMES?: string;
  PRESIGN_WINDOW_SECONDS?: string;
  PRESIGN_EXPIRY_SECONDS?: string;
  UPLOAD_MAX_BYTES_IMAGE?: string;
  UPLOAD_MAX_BYTES_VIDEO?: string;
  UPLOAD_URL_EXPIRY_SECONDS?: string;
  PROFILE_SCOPE_TTL_SECONDS?: string;
  CONFIG_REFRESH_SECONDS?: string;
  ID_RANDOM_CHARS?: string;
  POINT_TIERS_VERSION?: string;

  DEFAULT_SUBMISSION_CONTEXT?: string;

  STUDENT_TOKEN_TTL_SECONDS?: string;
  PHONE_TOKEN_TTL_SECONDS?: string;

  SESSION_IDLE_TIMEOUT_MS?: string;
  SESSION_MAX_LIFETIME_MS?: string;
  CHAT_IDLE_TIMEOUT_MS?: string;
  CHAT_MAX_HISTORY_TURNS?: string;
  CHAT_MAX_EXCHANGES_PER_SESSION?: string;
  CHAT_MAX_EXCHANGES_PER_STUDENT_PER_DAY?: string;
  CHAT_MAX_CONTEXT_BYTES?: string;
  BQ_FLUSH_RETRY_DELAY_MS?: string;
  BQ_MAX_FLUSH_RETRIES?: string;
  BQ_DAILY_BYTE_BUDGET?: string;
  MAX_TAPS_PER_ROW?: string;
  BQ_WRITE_TIMEOUT_MS?: string;

  ENVIRONMENT: "staging" | "production";

  STUDENT_SESSION: DurableObjectNamespace;
  CHAT_SESSION: DurableObjectNamespace;

  REQUEST_ANALYTICS: AnalyticsEngineDataset;
}

export type RouteClass = "write" | "read" | "chat" | "telemetry" | "auth";
export type SubmissionType = "image" | "video";
export type ActivityContext = "program" | "event";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "STUDENT_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "NOT_READY"
  | "UPSTREAM_ERROR"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "SERVER_ERROR"
  | "upload_not_confirmed"
  | "upload_size_invalid"
  | "upload_type_mismatch";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Frappe's own error_code, when this AppError was built from a Frappe response.
   *  Lets a client distinguish "course_completed" from "weekly_cap_reached" from a
   *  message-derived slug, without parsing `message` as if it were a machine code. */
  readonly subCode?: string;
  constructor(code: ErrorCode, message: string, httpStatus = 400, subCode?: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.subCode = subCode;
  }
}

export const unauthorized = (msg = "Unauthorized", subCode?: string) => new AppError("UNAUTHORIZED", msg, 401, subCode);
export const forbidden = (msg = "Forbidden", subCode?: string) => new AppError("FORBIDDEN", msg, 403, subCode);
export const studentNotFound = (msg = "Student not found", subCode?: string) =>
  new AppError("STUDENT_NOT_FOUND", msg, 404, subCode);
export const invalidInput = (msg: string, subCode?: string) => new AppError("INVALID_INPUT", msg, 400, subCode);
export const notFound = (msg: string, subCode?: string) => new AppError("NOT_FOUND", msg, 404, subCode);
export const notReady = (msg = "Not ready yet") => new AppError("NOT_READY", msg, 409);
export const upstreamError = (msg: string) => new AppError("UPSTREAM_ERROR", msg, 502);
export const rateLimited = (msg = "Rate limit exceeded") => new AppError("RATE_LIMITED", msg, 429);
export const conflict = (msg: string, subCode?: string) => new AppError("CONFLICT", msg, 409, subCode);
export const serverError = (msg = "Internal server error") => new AppError("SERVER_ERROR", msg, 500);

export const uploadNotConfirmed = (msg = "Upload not confirmed on storage") =>
  new AppError("upload_not_confirmed", msg, 400);
export const uploadSizeInvalid = (msg = "Uploaded file size is out of bounds") =>
  new AppError("upload_size_invalid", msg, 400);
export const uploadTypeMismatch = (msg = "Uploaded file content type does not match") =>
  new AppError("upload_type_mismatch", msg, 400);

export const VALID_ACTIVITY_CONTEXTS: readonly ActivityContext[] = ["program", "event"] as const;

export function parseActivityContext(raw: unknown, fallback: ActivityContext): ActivityContext {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (raw === "program" || raw === "event") return raw;
  throw invalidInput('context must be "program" or "event"');
}