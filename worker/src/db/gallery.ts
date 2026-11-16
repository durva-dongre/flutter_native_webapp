/**
 * db/gallery.ts — D1-backed `gallery_items` table: the ONLY listing source for the
 * gallery (never Frappe, never a raw R2 list() at read time). Rows land here via
 * /internal/gallery/index, called by Frappe's nightly gallery_promotion_sweep job
 * (not a synchronous per-submission call anymore).
 *
 * Write path now chunks its own D1 batch writes internally (D1_BATCH_HARD_CAP),
 * independent of whatever chunk size the caller (Frappe's sweep) sends in one HTTP
 * call -- this keeps one db.batch() call safely under D1's own statement-count
 * comfort zone regardless of how large gallery_index_chunk_size is configured.
 *
 * Also exports fetchKnownSubmissionIds, a paginated read of which submission_ids are
 * already indexed since a given timestamp -- used by the nightly sweep's "pending =
 * eligible minus known" set-difference computation (see
 * handlers/internalHandlers.ts::knownIds and
 * tap_lms/shared/jobs/gallery_promotion_sweep.py).
 *
 * Client-facing GalleryImage returns the submission's numeric mark as `points`
 * (never `score`) — matching the rest of the API's points/points_awarded/points_tier
 * naming. The underlying D1 column is still named `score`.
 *
 * FALLBACK CASCADE — generalized to ANY level, with or without a grade filter:
 * cfg.GALLERY_FALLBACK_CASCADE is an ordered list of GalleryCascadeStep
 * ({field, gradeMode}) entries (config/defaults.ts). Each step independently chooses
 * which identity column to filter on (assignment_id | state | district | school) AND
 * whether to also filter by the caller's grade ("exact") or ignore grade entirely
 * ("any"). This replaces the earlier design where grade was implicitly ANDed into
 * every level unconditionally — "same school, any grade" (or same district/state,
 * any grade) is now just another explicit, orderable step, not a special case.
 *
 * COST CONTROL — the empty-level cache (cache/galleryLevelCache.ts): before issuing a
 * D1 query for a cascade step, fetchGalleryPage first checks whether THAT EXACT step
 * (field + gradeMode + value[+grade]) is already cached as "known empty." A hit skips
 * the D1 query outright and moves to the next step; a miss queries D1 as before, and
 * the result (empty or not) is written back to that cache so the next request for the
 * same step/scope doesn't re-pay the same D1 query. Only emptiness is cached — see
 * cache/galleryLevelCache.ts's own docblock for why a non-empty result is never cached
 * there (the page-level cache already covers that case).
 *
 * The raw storage key is NEVER returned to the client — rowsToPage/toSignedImages
 * resolve it to a signed `url` and drop the key itself from the response shape.
 *
 * Expected D1 schema (create via migration, not here):
 *
 *   CREATE TABLE gallery_items (
 *     submission_id   TEXT PRIMARY KEY,
 *     academic_year   INTEGER NOT NULL,
 *     assignment_id   TEXT NOT NULL,
 *     student_id      TEXT NOT NULL,
 *     first_name      TEXT,
 *     state           TEXT NOT NULL,
 *     district        TEXT NOT NULL,
 *     school          TEXT NOT NULL,
 *     grade           INTEGER NOT NULL,
 *     media_type      TEXT NOT NULL DEFAULT 'image',
 *     object_key      TEXT NOT NULL,
 *     score           REAL,
 *     promoted_at     INTEGER NOT NULL,
 *     updated_at      INTEGER NOT NULL DEFAULT 0,
 *     visible         INTEGER NOT NULL DEFAULT 1
 *   );
 *   CREATE INDEX idx_gallery_school_grade ON gallery_items(school, grade, visible, promoted_at);
 *   CREATE INDEX idx_gallery_school ON gallery_items(school, visible, promoted_at);
 *   CREATE INDEX idx_gallery_district_grade ON gallery_items(district, grade, visible, promoted_at);
 *   CREATE INDEX idx_gallery_district ON gallery_items(district, visible, promoted_at);
 *   CREATE INDEX idx_gallery_state_grade ON gallery_items(state, grade, visible, promoted_at);
 *   CREATE INDEX idx_gallery_state ON gallery_items(state, visible, promoted_at);
 *   CREATE INDEX idx_gallery_assignment_grade ON gallery_items(assignment_id, grade, visible, promoted_at);
 *   CREATE INDEX idx_gallery_assignment ON gallery_items(assignment_id, visible, promoted_at);
 *
 *   -- Each location level now has TWO indexes: one including grade (for "exact"
 *   -- cascade steps) and one without (for "any" steps) -- a "WHERE school = ? AND
 *   -- visible = 1 ORDER BY promoted_at" query cannot efficiently use an index whose
 *   -- leading columns are (school, grade, visible, promoted_at), since grade is
 *   -- absent from that query's WHERE clause entirely. Both indexes are needed for the
 *   -- cascade to stay index-only at every step.
 */

import type { ConfigSchema } from "../config/defaults";
import type { GalleryScopeField, GalleryCascadeStep } from "../config/defaults";
import type { Env } from "../env";
import { r2SignGetDirect, type R2SignEnv } from "../storage/r2";
import { getCachedGalleryRow, putCachedGalleryRow } from "../cache/galleryRowCache";
import { isLevelKnownEmpty, markLevelEmpty, type LevelEmptyKeyParams } from "../cache/galleryLevelCache";

/** Which of the fixed fields the API caller may pass explicitly (vs. always
 *  profile-derived). Pure API ergonomics knob — widening later is a one-line change. */
export const GALLERY_QUERY_OVERRIDABLE_FIELDS = ["school", "grade"] as const;

export const GALLERY_SCOPE_FIELD_PATTERNS: Readonly<Record<GalleryScopeField, RegExp>> = {
  assignment_id: /^[A-Za-z0-9_ -]{3,80}$/,
  state: /^[a-z0-9-]{2,40}$/,
  district: /^[a-z0-9-]{2,60}$/,
  school: /^[a-z0-9-]{2,60}$/,
};

export function normalizeScopeValue(v: string): string {
  return v.trim().toLowerCase();
}

/** Hard cap on how many bound statements one db.batch() call carries. A Worker-code
 *  constant, not a Shared Settings field — it's an infrastructure safety limit, not a
 *  tunable business parameter, and keeping it a constant avoids someone accidentally
 *  setting it dangerously high via the config UI. Deliberately decoupled from the
 *  API-layer chunk size (Frappe's gallery_index_chunk_size, default 100): that one is
 *  about keeping one HTTP request/response reasonable, this one is about keeping one
 *  D1 .batch() call's statement count safe, independent of what the API layer accepts. */
const D1_BATCH_HARD_CAP = 50;

/** Hard cap on known_ids page size, enforced regardless of what the caller requests. */
const KNOWN_IDS_MAX_PAGE_LIMIT = 500;

// ─────────────────────────────────────────────────────────────────────────
// Read path — fetchGalleryPage
// ─────────────────────────────────────────────────────────────────────────

export interface GalleryImageRow {
  submission_id: string;
  student_id: string;
  first_name: string | null;
  object_key: string;
  media_type: "image" | "video";
  /** The submission's numeric mark, read from D1's `score` column. Carried as
   *  `points` from here on — never `score` — to match the wire shape every other
   *  submission-shaped response in this API uses (points/points_awarded/points_tier). */
  points: number | null;
  promoted_at: number;
  updated_at: number;
}

/** Client-facing shape — NO submission_id, NO object_key/raw storage key, only a
 *  resolved url. submission_id stays purely internal (used as the row-cache key in
 *  toSignedImages below) and is never put into this object. The submission's mark is
 *  returned as `points` (never `score`) — see module docblock. */
export interface GalleryImage {
  display_name: string | null;
  url: string;
  media_type: "image" | "video";
  points: number | null;
  uploaded: string;
}

export interface GalleryPage {
  images: GalleryImage[];
  cursor: number | null;
  truncated: boolean;
  matched_level: GalleryScopeField | "none";
  /** Whether the matched level also matched the caller's exact grade, or ignored
   *  grade entirely ("any"). "none" when matched_level is "none". Lets a client
   *  distinguish "this is from your grade" from "this is from your school, but a
   *  different grade" without guessing from matched_level alone. */
  matched_grade_mode: "exact" | "any" | "none";
  fallback_applied: boolean;
}

export interface GalleryQuery {
  assignmentId?: string;
  state: string;
  district: string;
  school: string;
  grade: number;
  cursor: number | null;
  limit: number;
}

interface D1GalleryRow {
  submission_id: string;
  student_id: string;
  first_name: string | null;
  object_key: string;
  media_type: string;
  score: number | null;
  promoted_at: number;
  updated_at: number;
}

const LOCATION_COLUMN_FOR: Readonly<Record<GalleryScopeField, string>> = {
  assignment_id: "assignment_id",
  state: "state",
  district: "district",
  school: "school",
};

/** Resolves which scope value a cascade step's `field` reads from the caller's
 *  GalleryQuery. Centralized here so queryLevel and the level-cache key builder agree
 *  on exactly the same value for the exact same step, by construction. */
function scopeValueFor(field: GalleryScopeField, q: GalleryQuery): string | undefined {
  switch (field) {
    case "assignment_id":
      return q.assignmentId;
    case "state":
      return q.state;
    case "district":
      return q.district;
    case "school":
      return q.school;
  }
}

function orderByClause(sort: ConfigSchema["GALLERY_SORT"]): string {
  return sort === "updated" ? "updated_at DESC" : "promoted_at DESC";
}

/**
 * Runs ONE cascade step's D1 query. Builds its WHERE clause from `step.field` and,
 * only when step.gradeMode === "exact", ANDs in `grade = ?`. A step whose scope value
 * is empty/undefined (e.g. an "assignment_id" step when the caller never supplied or
 * resolved one) returns [] immediately with no query at all — there is nothing to
 * filter on, so there is nothing to ask D1 for.
 */
async function queryD1ForStep(
  db: D1Database,
  step: GalleryCascadeStep,
  value: string,
  q: GalleryQuery,
  sort: ConfigSchema["GALLERY_SORT"]
): Promise<D1GalleryRow[]> {
  const limitPlusOne = q.limit + 1;
  const offset = q.cursor ?? 0;
  const orderBy = orderByClause(sort);
  const column = LOCATION_COLUMN_FOR[step.field];

  if (step.gradeMode === "exact") {
    const { results } = await db
      .prepare(
        `SELECT submission_id, student_id, first_name, object_key, media_type, score, promoted_at, updated_at
         FROM gallery_items
         WHERE ${column} = ?1 AND grade = ?2 AND visible = 1
         ORDER BY ${orderBy}
         LIMIT ?3 OFFSET ?4`
      )
      .bind(value, q.grade, limitPlusOne, offset)
      .all<D1GalleryRow>();
    return results ?? [];
  }

  // gradeMode === "any": no grade predicate at all, so a different index
  // (column, visible, promoted_at) — WITHOUT grade as a leading column — is what
  // keeps this index-only. See the schema note in the module docblock.
  const { results } = await db
    .prepare(
      `SELECT submission_id, student_id, first_name, object_key, media_type, score, promoted_at, updated_at
       FROM gallery_items
       WHERE ${column} = ?1 AND visible = 1
       ORDER BY ${orderBy}
       LIMIT ?2 OFFSET ?3`
    )
    .bind(value, limitPlusOne, offset)
    .all<D1GalleryRow>();
  return results ?? [];
}

function rowsToPage(
  rows: D1GalleryRow[],
  limit: number,
  cursor: number | null
): { images: GalleryImageRow[]; cursor: number | null; truncated: boolean } {
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const nextCursor = truncated ? (cursor ?? 0) + limit : null;
  return {
    images: page.map((r) => ({
      submission_id: r.submission_id,
      student_id: r.student_id,
      first_name: r.first_name,
      object_key: r.object_key,
      media_type: (r.media_type === "video" ? "video" : "image") as "image" | "video",
      // D1 column is `score`; wire/TS field is `points` — see module docblock.
      points: r.score,
      promoted_at: r.promoted_at,
      updated_at: r.updated_at,
    })),
    cursor: nextCursor,
    truncated,
  };
}

/**
 * Walks cfg.GALLERY_FALLBACK_CASCADE in array order, stopping at the first step that
 * actually has at least one matching row. For EACH step, in order:
 *
 *   1. Resolve the step's scope value from the query (scopeValueFor). A step with no
 *      resolvable value (e.g. an "assignment_id" step when the caller has none) is
 *      skipped outright — no cache check, no D1 query, exactly like before.
 *   2. Check the empty-level cache (isLevelKnownEmpty) for this EXACT
 *      (field, gradeMode, value[, grade]) combination. A hit means this step is
 *      already known to have nothing — skip straight to the next cascade step with NO
 *      D1 query at all. This is the cost-control path: a school with no eligible
 *      submissions yet stops costing a D1 query on every single request once the
 *      first request has established that fact, for up to
 *      GALLERY_LEVEL_EMPTY_CACHE_SECONDS.
 *   3. On a cache MISS, actually query D1 (queryD1ForStep). If it comes back with
 *      rows, return this page immediately — cascade stops here. If it comes back
 *      empty, write the empty marker (markLevelEmpty) so the next request for this
 *      same step/scope skips the D1 query too, then continue to the next step.
 *
 * If GALLERY_FALLBACK_ENABLED is false, only the FIRST step in the cascade is ever
 * tried — no widening on an empty result, matching the pre-existing kill-switch
 * semantics exactly.
 */
export async function fetchGalleryPage(
  db: D1Database,
  _env: Env,
  cfg: Pick<
    ConfigSchema,
    | "GALLERY_FALLBACK_ENABLED"
    | "GALLERY_FALLBACK_CASCADE"
    | "GALLERY_SORT"
    | "PRESIGN_WINDOW_SECONDS"
    | "PRESIGN_EXPIRY_SECONDS"
    | "GALLERY_ROW_CACHE_SECONDS"
    | "GALLERY_LEVEL_EMPTY_CACHE_SECONDS"
  >,
  query: GalleryQuery,
  r2Env: R2SignEnv
): Promise<GalleryPage> {
  const cascade = cfg.GALLERY_FALLBACK_CASCADE;

  for (let i = 0; i < cascade.length; i++) {
    const step = cascade[i] as GalleryCascadeStep;
    const value = scopeValueFor(step.field, query);
    if (!value) {
      // Nothing to filter on for this step at all (e.g. no assignment_id resolved).
      // Not even cacheable as "empty" — there's no scope value to key that cache
      // entry on — so just move straight to the next step.
      if (!cfg.GALLERY_FALLBACK_ENABLED) break;
      continue;
    }

    const levelKeyParams: LevelEmptyKeyParams = {
      field: step.field,
      gradeMode: step.gradeMode,
      value,
      grade: step.gradeMode === "exact" ? query.grade : undefined,
    };

    const knownEmpty = await isLevelKnownEmpty(levelKeyParams);
    if (knownEmpty) {
      if (!cfg.GALLERY_FALLBACK_ENABLED) break;
      continue;
    }

    const rows = await queryD1ForStep(db, step, value, query, cfg.GALLERY_SORT);

    if (rows.length > 0) {
      const { images, cursor, truncated } = rowsToPage(rows, query.limit, query.cursor);
      return {
        images: await toSignedImages(images, r2Env, cfg),
        cursor,
        truncated,
        matched_level: step.field,
        matched_grade_mode: step.gradeMode,
        fallback_applied: i > 0,
      };
    }

    // Empty result from a real D1 query — cache that fact so the NEXT request for
    // this same (field, gradeMode, value[, grade]) skips the D1 round trip entirely.
    // Only cacheable because we actually queried; a step skipped above for having no
    // scope value was never queried and has nothing meaningful to cache.
    await markLevelEmpty(levelKeyParams, cfg);

    if (!cfg.GALLERY_FALLBACK_ENABLED) break;
  }

  return {
    images: [],
    cursor: null,
    truncated: false,
    matched_level: "none",
    matched_grade_mode: "none",
    fallback_applied: cascade.length > 1,
  };
}

/**
 * Signs each row's object_key as a fresh R2 GET url, going through the per-row cache
 * (cache/galleryRowCache.ts) keyed by submission_id FIRST — a cache hit means no R2
 * signing and no D1-adjacent work for that row at all, regardless of which scope
 * query surfaced it. A miss signs it, then caches the result for
 * GALLERY_ROW_CACHE_SECONDS. submission_id itself is used only as the cache key here
 * and is dropped from the returned GalleryImage — the client never sees it. The
 * submission's mark rides along as `points` end to end (never `score`).
 */
async function toSignedImages(
  rows: GalleryImageRow[],
  r2Env: R2SignEnv,
  cfg: Pick<ConfigSchema, "PRESIGN_WINDOW_SECONDS" | "PRESIGN_EXPIRY_SECONDS" | "GALLERY_ROW_CACHE_SECONDS">
): Promise<GalleryImage[]> {
  return Promise.all(
    rows.map(async (r): Promise<GalleryImage> => {
      const cached = await getCachedGalleryRow(r.submission_id);
      if (cached) {
        return {
          display_name: cached.display_name ?? r.first_name,
          url: cached.url,
          media_type: r.media_type,
          points: r.points,
          uploaded: cached.uploaded,
        };
      }

      const url = await r2SignGetDirect(r.object_key, r2Env, cfg);
      const uploaded = new Date(r.promoted_at * 1000).toISOString();

      await putCachedGalleryRow(r.submission_id, { url, uploaded, display_name: r.first_name ?? undefined }, cfg);

      return { display_name: r.first_name, url, media_type: r.media_type, points: r.points, uploaded };
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Write path — called only from handlers/internalHandlers.ts, itself gated by
// INTERNAL_API_SECRET (never reachable from the app).
// ─────────────────────────────────────────────────────────────────────────

export interface PromoteRow {
  academicYear: number;
  assignmentId: string;
  studentId: string;
  submissionId: string;
  firstName?: string;
  state: string;
  district: string;
  school: string;
  grade: number;
  mediaType: "image" | "video";
  /** The R2 object key this submission's media was copied to. Required — a row with
   *  no object_key has nothing to sign on read. */
  objectKey: string;
  score?: number;
  promotedAt: number;
  updatedAt?: number;
}

function buildUpsertStatement(db: D1Database) {
  return db.prepare(
    `INSERT INTO gallery_items
       (submission_id, academic_year, assignment_id, student_id, first_name, state, district, school, grade, media_type, object_key, score, promoted_at, updated_at, visible)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1)
     ON CONFLICT(submission_id) DO UPDATE SET
       academic_year = excluded.academic_year,
       assignment_id = excluded.assignment_id,
       student_id = excluded.student_id,
       first_name = excluded.first_name,
       state = excluded.state,
       district = excluded.district,
       school = excluded.school,
       grade = excluded.grade,
       media_type = excluded.media_type,
       object_key = excluded.object_key,
       score = excluded.score,
       promoted_at = excluded.promoted_at,
       updated_at = excluded.updated_at`
  );
}

/**
 * Chunks rows internally into groups of D1_BATCH_HARD_CAP and calls db.batch() once
 * per group, sequentially. External signature/behavior is unchanged from the caller's
 * perspective — it still just "upserts all these rows" — so no caller needs to change,
 * this is purely an internal safety measure against a larger-than-before input (the
 * nightly sweep can send up to gallery_index_chunk_size rows in one call, which can
 * exceed what's comfortable for one D1 .batch() call).
 */
export async function upsertGalleryItems(db: D1Database, rows: PromoteRow[]): Promise<void> {
  if (rows.length === 0) return;

  const stmt = buildUpsertStatement(db);

  for (let i = 0; i < rows.length; i += D1_BATCH_HARD_CAP) {
    const group = rows.slice(i, i + D1_BATCH_HARD_CAP);
    const batched = group.map((r) =>
      stmt.bind(
        r.submissionId,
        r.academicYear,
        r.assignmentId,
        r.studentId,
        r.firstName ?? null,
        r.state,
        r.district,
        r.school,
        r.grade,
        r.mediaType,
        r.objectKey,
        r.score ?? null,
        r.promotedAt,
        r.updatedAt ?? r.promotedAt
      )
    );
    await db.batch(batched);
  }
}

export async function setGalleryItemVisibility(db: D1Database, submissionId: string, visible: boolean): Promise<void> {
  await db
    .prepare(`UPDATE gallery_items SET visible = ?1 WHERE submission_id = ?2`)
    .bind(visible ? 1 : 0, submissionId)
    .run();
}

// ─────────────────────────────────────────────────────────────────────────
// known_ids read path — nightly sweep's "what does D1 already have" lookup.
// ─────────────────────────────────────────────────────────────────────────

export interface KnownIdsPage {
  ids: string[];
  nextCursor: number | null;
}

/**
 * One page of submission_ids already indexed since sinceEpoch, ordered by
 * (promoted_at, submission_id) for deterministic keyset-style pagination. Reuses the
 * same "ask for limit+1, slice, detect truncation" pattern queryD1ForStep already uses
 * for the gallery's own read path, for consistency. limit is clamped to
 * KNOWN_IDS_MAX_PAGE_LIMIT server-side regardless of what's requested.
 */
export async function fetchKnownSubmissionIds(
  db: D1Database,
  sinceEpoch: number,
  cursor: number | null,
  limit: number
): Promise<KnownIdsPage> {
  const cappedLimit = Math.min(Math.max(limit, 1), KNOWN_IDS_MAX_PAGE_LIMIT);
  const offset = cursor ?? 0;
  const limitPlusOne = cappedLimit + 1;

  const { results } = await db
    .prepare(
      `SELECT submission_id FROM gallery_items
       WHERE promoted_at >= ?1
       ORDER BY promoted_at ASC, submission_id ASC
       LIMIT ?2 OFFSET ?3`
    )
    .bind(sinceEpoch, limitPlusOne, offset)
    .all<{ submission_id: string }>();

  const rows = results ?? [];
  const truncated = rows.length > cappedLimit;
  const page = truncated ? rows.slice(0, cappedLimit) : rows;
  const nextCursor = truncated ? offset + cappedLimit : null;

  return { ids: page.map((r) => r.submission_id), nextCursor };
}

/**
 *
 * Fixes: assignment_id scoping was silently broken for any space-containing
 * assignment_id. The write path (Frappe's sweep) sanitizes assignment_id by
 * collapsing disallowed characters to '-'; the read path (gallery query param
 * and profile-derived default) previously used the value as-is. A real,
 * exactly-matching assignment_id containing a space would never match any
 * row. This function must be applied to both the query-param value and the
 * profile-derived value before either is used anywhere -- see
 * galleryHandlers.ts for the call sites.
 */

export function normalizeAssignmentIdForScope(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const collapsed = v.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return collapsed || undefined;
}