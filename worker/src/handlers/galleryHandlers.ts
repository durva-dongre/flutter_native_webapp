/**
 * handlers/galleryHandlers.ts
 * Both the query-param and profile-derived assignment_id are run through
 * normalizeAssignmentIdForScope() right after shape validation, so the
 * value bound into the D1 WHERE clause always matches what the nightly
 * sweep wrote, regardless of spaces in the raw id.
 *
 * FIX: analytics threaded through and passed into enforceRateLimit with
 * this route's own path (read-class, so no turn budget configured by
 * default, but still gets burst-remaining recorded correctly now).
 */

import { requireStudentToken } from "../auth/middleware";
import type { Env } from "../env";
import { invalidInput } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { config } from "../config/index";
import { fetchGalleryPage, normalizeAssignmentIdForScope } from "../db/gallery";
import { getCachedGalleryPage, putCachedGalleryPage, type GalleryCacheKeyParams } from "../cache/galleryPageCache";
import { getProfileScope } from "../storage/profileScope";
import { mintScopeToken, verifyScopeToken } from "../storage/scopeToken";
import { collectTelemetry } from "../telemetry/collector";
import { FIELD_PATTERNS } from "../storage/keys";
import type { RequestAnalyticsContext } from "../router";

const ASSIGNMENT_ID_PATTERN = FIELD_PATTERNS.assignment_id;
const GRADE_PATTERN = /^[1-9][0-9]?$/;
const GALLERY_CACHE_GENERATION_KEY = "gallery_cache_generation";
const ROUTE_GALLERY = "/gallery";

const UNRESOLVED_GRADE = 0;

function resolveProfileGrade(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : UNRESOLVED_GRADE;
}

async function readGalleryCacheGeneration(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM app_config WHERE key = ?1`)
    .bind(GALLERY_CACHE_GENERATION_KEY)
    .first<{ value: string }>();
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}

async function gallery(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "read", ROUTE_GALLERY, analytics);

  const cfg = config(env, env as unknown as Record<string, string>, ctx);
  const url = new URL(req.url);

  const queryAssignmentIdRaw = url.searchParams.get("assignment_id") ?? undefined;
  if (queryAssignmentIdRaw !== undefined && !ASSIGNMENT_ID_PATTERN.test(queryAssignmentIdRaw)) {
    throw invalidInput("assignment_id is malformed");
  }

  const gradeParam = url.searchParams.get("grade");
  let grade: number | undefined;
  const gradeSource = gradeParam !== null && gradeParam !== "" ? "query" : "default";
  if (gradeParam !== null && gradeParam !== "") {
    if (!GRADE_PATTERN.test(gradeParam)) throw invalidInput("grade is malformed");
    grade = Number(gradeParam);
  }

  const sortParam = url.searchParams.get("sort");
  const sort = sortParam ?? cfg.GALLERY_SORT;
  const sortSource = sortParam ? "query" : "default";

  const limitParam = url.searchParams.get("limit");
  let limit = cfg.GALLERY_PAGE_DEFAULT;
  if (limitParam !== null && limitParam !== "") {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1) throw invalidInput("limit is malformed");
    limit = Math.min(n, cfg.GALLERY_PAGE_MAX);
  }

  const cursorParam = url.searchParams.get("cursor");
  let cursor: number | null = null;
  if (cursorParam !== null && cursorParam !== "") {
    const n = Number(cursorParam);
    if (!Number.isInteger(n) || n < 0) throw invalidInput("cursor is malformed");
    cursor = n;
  }

  const scopeTokenParam = url.searchParams.get("scope_cache_token");
  let profileScope = await verifyScopeToken(scopeTokenParam, env.GALLERY_SCOPE_TOKEN_SECRET);
  if (!profileScope) {
    profileScope = await getProfileScope(env, cfg, studentId);
  }
  if (grade === undefined) {
    grade = resolveProfileGrade(profileScope.grade);
  }

  // Normalize both possible sources the exact same way the nightly sweep
  // normalized assignment_id when writing to D1 — this is what makes the
  // bound WHERE-clause value match a space-containing assignment_id.
  let assignmentId: string | undefined;
  let assignmentIdSource: "query" | "profile" | "default" = "default";

  if (queryAssignmentIdRaw) {
    assignmentId = normalizeAssignmentIdForScope(queryAssignmentIdRaw);
    if (assignmentId) assignmentIdSource = "query";
  }
  if (!assignmentId && profileScope.assignmentId && ASSIGNMENT_ID_PATTERN.test(profileScope.assignmentId)) {
    const normalized = normalizeAssignmentIdForScope(profileScope.assignmentId);
    if (normalized) {
      assignmentId = normalized;
      assignmentIdSource = "profile";
    }
  }

  const generation = await readGalleryCacheGeneration(env.DB);

  const cacheParams: GalleryCacheKeyParams = {
    scopeMode: assignmentId ? "assignment" : "school_grade",
    assignmentId,
    state: profileScope.state,
    district: profileScope.district,
    school: profileScope.school,
    grade,
    limit,
    cursor,
    generation,
  };

  let page = await getCachedGalleryPage(cacheParams);
  if (!page) {
    page = await fetchGalleryPage(
      env.DB,
      env,
      cfg,
      {
        assignmentId,
        state: profileScope.state,
        district: profileScope.district,
        school: profileScope.school,
        grade,
        cursor,
        limit,
      },
      env
    );
    ctx.waitUntil(putCachedGalleryPage(cacheParams, page, cfg));
  }

  const scopeCacheToken = await mintScopeToken(profileScope, cfg.PROFILE_SCOPE_TTL_SECONDS, env.GALLERY_SCOPE_TOKEN_SECRET);

  ctx.waitUntil(collectTelemetry(env, studentId, null).catch(() => {}));

  const responseData: Record<string, unknown> = {
    assignment_id: assignmentId,
    grade: String(grade),
    sort,
    params_source: { assignment_id: assignmentIdSource, grade: gradeSource, sort: sortSource },
    matched_level: page.matched_level,
    matched_grade_mode: page.matched_grade_mode,
    fallback_applied: page.fallback_applied,
    images: page.images,
    cursor: page.cursor,
    truncated: page.truncated,
    scope_cache_token: scopeCacheToken,
  };

  return ok(responseData);
}

export const galleryHandlers = { gallery };