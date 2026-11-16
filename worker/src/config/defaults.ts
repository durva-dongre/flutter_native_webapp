/**
 * config/defaults.ts — every tunable in one place, three-layer precedence resolved by
 * config/index.ts: D1 app_config > wrangler [vars] > these defaults.
 *
 * BUGFIX (this rewrite): added "request_upload" to IDEMPOTENCY_TTL_BY_ROUTE, needed by
 * the request_upload idempotency fix in handlers/submissionHandlers.ts (previously
 * request_upload had no idempotency key support at all — see that file's docblock).
 */

export type RouteClass = "write" | "read" | "chat" | "telemetry" | "auth";
export type SubmissionType = "image" | "video" | "text";
export type ActivityContext = "program" | "event";
export type GallerySortMode = "recent" | "updated";

/** Every LOCATION/identity field the gallery can ever scope a query by. "grade" is
 *  deliberately NOT a member of this list — it is never a standalone scoping level on
 *  its own; it is instead an optional AND-filter layered onto any of the levels below,
 *  controlled per-cascade-step by GalleryCascadeStep.gradeMode (see below). This is
 *  what makes "fall back to this same level, but ANY grade" an explicit, orderable
 *  step in the cascade rather than a hardcoded special case. */
export const GALLERY_SCOPE_FIELDS = ["assignment_id", "state", "district", "school"] as const;
export type GalleryScopeField = (typeof GALLERY_SCOPE_FIELDS)[number];

/**
 * One step in the gallery's fallback cascade. `field` names which identity column to
 * filter on ("assignment_id" | "state" | "district" | "school"); `gradeMode` says
 * whether THIS step also filters by the caller's grade ("exact") or ignores grade
 * entirely ("any"). "assignment_id" always implies "exact" grade semantics are the
 * normal, narrowest case — but even that level supports "any" (handed the same
 * assignment, any grade) and is spelled out explicitly rather than assumed, so every
 * step's semantics is visible by reading the cascade, not by special-casing a level
 * name.
 *
 * The cascade is walked in array order, stopping at the first step whose query (or
 * whose cached empty-marker — see cache/galleryLevelCache.ts) returns at least one
 * row. GALLERY_FALLBACK_ENABLED:false means only the first step is ever tried.
 */
export interface GalleryCascadeStep {
  field: GalleryScopeField;
  gradeMode: "exact" | "any";
}

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

export interface ConfigSchema {
  ID_RANDOM_CHARS: number;

  DEFAULT_SUBMISSION_CONTEXT: ActivityContext;

  MEDIA_MODE_GALLERY: "public" | "presigned";
  MEDIA_MODE_OWN: "public" | "presigned";
  PRESIGN_WINDOW_SECONDS: number;
  PRESIGN_EXPIRY_SECONDS: number;

  UPLOAD_MAX_BYTES_IMAGE: number;
  UPLOAD_MAX_BYTES_VIDEO: number;
  UPLOAD_URL_EXPIRY_SECONDS: number;

  GALLERY_FALLBACK_CASCADE: readonly GalleryCascadeStep[];
  GALLERY_FALLBACK_ENABLED: boolean;
  GALLERY_SORT: GallerySortMode;
  GALLERY_PAGE_DEFAULT: number;
  GALLERY_PAGE_MAX: number;
  GALLERY_PAGE_CACHE_SECONDS: number;
  GALLERY_ROW_CACHE_SECONDS: number;
  /** TTL for the "this cascade step currently has zero matching rows" marker
   *  (cache/galleryLevelCache.ts). Short relative to GALLERY_PAGE_CACHE_SECONDS --
   *  this cache only exists to skip D1 queries for steps that keep coming back empty
   *  within a short window (e.g. a school with no gallery-eligible submissions yet);
   *  it must not silently hide newly-promoted rows for as long as a full page cache
   *  entry would. */
  GALLERY_LEVEL_EMPTY_CACHE_SECONDS: number;
  GALLERY_SHOW_NAMES: "own_school" | "all" | "none";
  PROFILE_SCOPE_TTL_SECONDS: number;

  INDEX_BATCH_MAX: number;

  POINT_TIERS_VERSION: number;

  MAGIC_TTL_SECONDS_HOME: number;
  MAGIC_TTL_SECONDS_FEEDBACK: number;
  MAGIC_TTL_SECONDS_GALLERY: number;
  MAGIC_TTL_SECONDS_SUBMIT: number;
  MAGIC_TTL_SECONDS_LATER: number;

  STUDENT_TOKEN_TTL_SECONDS: number;
  PHONE_TOKEN_TTL_SECONDS: number;

  CONFIG_REFRESH_SECONDS: number;

  TURN_WINDOW_SECONDS: number;
  TURN_BUDGETS: Readonly<Record<string, number>>;
  DEFAULT_TURN_BUDGET: number;

  IDEMPOTENCY_TTL_BY_ROUTE: Readonly<Record<string, number>>;
  DEFAULT_IDEMPOTENCY_TTL_SECONDS: number;

  RATE_LIMITS: Readonly<Record<RouteClass, RateLimitRule>>;
}

export const RUNTIME_OVERRIDABLE_KEYS: ReadonlySet<keyof ConfigSchema> = new Set([
  "DEFAULT_SUBMISSION_CONTEXT",
  "MEDIA_MODE_GALLERY",
  "MEDIA_MODE_OWN",
  "PRESIGN_WINDOW_SECONDS",
  "PRESIGN_EXPIRY_SECONDS",
  "UPLOAD_MAX_BYTES_IMAGE",
  "UPLOAD_MAX_BYTES_VIDEO",
  "UPLOAD_URL_EXPIRY_SECONDS",
  "GALLERY_FALLBACK_CASCADE",
  "GALLERY_FALLBACK_ENABLED",
  "GALLERY_SORT",
  "GALLERY_PAGE_DEFAULT",
  "GALLERY_PAGE_MAX",
  "GALLERY_PAGE_CACHE_SECONDS",
  "GALLERY_ROW_CACHE_SECONDS",
  "GALLERY_LEVEL_EMPTY_CACHE_SECONDS",
  "GALLERY_SHOW_NAMES",
  "PROFILE_SCOPE_TTL_SECONDS",
  "INDEX_BATCH_MAX",
  "POINT_TIERS_VERSION",
  "STUDENT_TOKEN_TTL_SECONDS",
  "PHONE_TOKEN_TTL_SECONDS",
]);

const ONE_DAY_SECONDS = 24 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * ONE_DAY_SECONDS;

/**
 * Default cascade: narrowest-and-most-specific first, widening gradually, and for
 * every location level, trying the caller's own grade before giving up grade
 * filtering at that same level — so a student sees their own grade's work from their
 * own school before ever seeing a different grade from their own school, and sees
 * their own school before ever falling back to district/state.
 */
export const DEFAULT_GALLERY_CASCADE: readonly GalleryCascadeStep[] = [
  { field: "assignment_id", gradeMode: "exact" },
  { field: "school", gradeMode: "exact" },
  { field: "school", gradeMode: "any" },
  { field: "district", gradeMode: "exact" },
  { field: "district", gradeMode: "any" },
  { field: "state", gradeMode: "exact" },
  { field: "state", gradeMode: "any" },
];

export const DEFAULT_CONFIG: ConfigSchema = {
  ID_RANDOM_CHARS: 10,

  DEFAULT_SUBMISSION_CONTEXT: "program",

  MEDIA_MODE_GALLERY: "presigned",
  MEDIA_MODE_OWN: "presigned",
  PRESIGN_WINDOW_SECONDS: ONE_DAY_SECONDS,
  PRESIGN_EXPIRY_SECONDS: SEVEN_DAYS_SECONDS,

  UPLOAD_MAX_BYTES_IMAGE: 10 * 1024 * 1024,
  UPLOAD_MAX_BYTES_VIDEO: 50 * 1024 * 1024,
  UPLOAD_URL_EXPIRY_SECONDS: 3600,

  GALLERY_FALLBACK_CASCADE: DEFAULT_GALLERY_CASCADE,
  GALLERY_FALLBACK_ENABLED: true,
  GALLERY_SORT: "recent",
  GALLERY_PAGE_DEFAULT: 24,
  GALLERY_PAGE_MAX: 50,
  GALLERY_PAGE_CACHE_SECONDS: ONE_DAY_SECONDS,
  GALLERY_ROW_CACHE_SECONDS: SEVEN_DAYS_SECONDS,
  GALLERY_LEVEL_EMPTY_CACHE_SECONDS: 15 * 60, // 15 minutes
  GALLERY_SHOW_NAMES: "own_school",
  PROFILE_SCOPE_TTL_SECONDS: ONE_DAY_SECONDS,

  INDEX_BATCH_MAX: 100,

  POINT_TIERS_VERSION: 1,

  MAGIC_TTL_SECONDS_HOME: 90 * 24 * 60 * 60,
  MAGIC_TTL_SECONDS_FEEDBACK: 30 * 24 * 60 * 60,
  MAGIC_TTL_SECONDS_GALLERY: 30 * 24 * 60 * 60,
  MAGIC_TTL_SECONDS_SUBMIT: 14 * 24 * 60 * 60,
  MAGIC_TTL_SECONDS_LATER: 14 * 24 * 60 * 60,

  STUDENT_TOKEN_TTL_SECONDS: 30 * 24 * 60 * 60,
  PHONE_TOKEN_TTL_SECONDS: 90 * 24 * 60 * 60,

  CONFIG_REFRESH_SECONDS: 300,

  TURN_WINDOW_SECONDS: 120,
  TURN_BUDGETS: {
    "/submission/request_upload": 2,
    "/submission/submit_artwork": 2,
    "/submission/do_later": 2,
    "/auth/redeem": 2,
    "/auth/select_profile": 2,
    "/progress/sync": 2,
    "/submission/get": 2,
  },
  DEFAULT_TURN_BUDGET: 1,

  IDEMPOTENCY_TTL_BY_ROUTE: {
    // BUGFIX: added so request_upload's new, optional idempotency support
    // (handlers/submissionHandlers.ts) has a configured TTL of its own,
    // same pattern as every other idempotent route below.
    request_upload: 3600,
    submit_artwork: 3600,
    submit_video_watched: 3600,
    submit_quiz: 3600,
    enroll_event: 3600,
  },
  DEFAULT_IDEMPOTENCY_TTL_SECONDS: 3600,

  RATE_LIMITS: {
    write: { max: 20, windowSeconds: 60 },
    read: { max: 60, windowSeconds: 60 },
    chat: { max: 10, windowSeconds: 60 },
    telemetry: { max: 30, windowSeconds: 60 },
    auth: { max: 120, windowSeconds: 60 },
  },
};