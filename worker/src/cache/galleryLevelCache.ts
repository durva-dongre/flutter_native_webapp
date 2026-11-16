/**
 * cache/galleryLevelCache.ts — "is this one cascade step known to currently have ZERO
 * matching rows" marker, keyed by (field, gradeMode, scopeValue, grade-if-exact).
 *
 * This exists purely to keep the cascade cost-effective: without it, a student whose
 * school has no gallery-eligible submissions yet would cause TWO D1 queries every
 * single gallery request forever (school/exact, then school/any) before ever reaching
 * district — even though the answer "this school has nothing" doesn't change between
 * one request and the next for long stretches of time. A hit here means "skip straight
 * to the next cascade step, no D1 round trip needed for this one."
 *
 * Keyed far more narrowly than cache/galleryPageCache.ts's own cache (which is keyed
 * by the FULL query including limit/cursor/sort/generation): this cache only needs to
 * answer "does this (field, gradeMode, value[, grade]) combination currently have ANY
 * visible row at all", which is a single, stable yes/no per combination, independent
 * of page size, cursor, or sort order — so one entry here backs every page-cache miss
 * for that combination, not just one specific limit/cursor.
 *
 * TTL (GALLERY_LEVEL_EMPTY_CACHE_SECONDS, default 15 minutes) is deliberately much
 * shorter than the page cache's own TTL (default 1 day): a "known empty" marker going
 * stale for 15 minutes after the nightly sweep adds the first row for that combination
 * is an acceptable, bounded delay; the page cache's longer TTL is fine because it is
 * actively invalidated via the gallery_cache_generation counter on every sweep run,
 * whereas this cache deliberately has NO generation dependency (that would defeat the
 * purpose — the whole point is to avoid needing a correctness mechanism as heavyweight
 * as the generation counter for what is, worst case, a 15-minute-stale "no" answer).
 *
 * Positive results (a step that DID find rows) are never written here — only emptiness
 * is cached. A step that found rows is already returned to the caller and, for page
 * caching purposes, captured by galleryPageCache.ts; caching "this step is non-empty"
 * here would buy nothing (the caller already queried D1 and got the rows) and would
 * risk staleness in the wrong direction (masking a row later being hidden/removed).
 */

import type { ConfigSchema } from "../config/defaults";
import type { GalleryScopeField } from "../config/defaults";

const NAMESPACE = "gallery-level-empty";

export interface LevelEmptyKeyParams {
  field: GalleryScopeField;
  gradeMode: "exact" | "any";
  /** The scope value for `field` (assignment_id, state, district, or school —
   *  whichever `field` names). Always required: every cascade step filters on some
   *  identity value. */
  value: string;
  /** Only meaningful (and only used in the cache key) when gradeMode === "exact". */
  grade?: number;
}

function levelCacheKey(params: LevelEmptyKeyParams): Request {
  const parts = [
    params.field,
    params.gradeMode,
    params.value,
    params.gradeMode === "exact" ? String(params.grade ?? "-") : "-",
  ].map(encodeURIComponent);
  return new Request(`https://gallery-level-empty.internal/${parts.join("/")}`);
}

/** True iff this exact (field, gradeMode, value[, grade]) combination is currently
 *  cached as having zero visible rows. False on a cache miss — callers must then
 *  actually query D1 to find out, and should call markLevelEmpty/markLevelNonEmpty
 *  afterward based on what they find. */
export async function isLevelKnownEmpty(params: LevelEmptyKeyParams): Promise<boolean> {
  const cache = await caches.open(NAMESPACE);
  const hit = await cache.match(levelCacheKey(params));
  return hit !== undefined;
}

export async function markLevelEmpty(
  params: LevelEmptyKeyParams,
  cfg: Pick<ConfigSchema, "GALLERY_LEVEL_EMPTY_CACHE_SECONDS">
): Promise<void> {
  if (cfg.GALLERY_LEVEL_EMPTY_CACHE_SECONDS <= 0) return;
  const cache = await caches.open(NAMESPACE);
  await cache.put(
    levelCacheKey(params),
    new Response("1", { headers: { "Cache-Control": `max-age=${cfg.GALLERY_LEVEL_EMPTY_CACHE_SECONDS}` } })
  );
}

/** Clears a previously-cached "empty" marker for one exact combination. Called when a
 *  write (index/visibility) could plausibly have just made a previously-empty
 *  combination non-empty, so the very next read for that combination re-queries D1
 *  instead of trusting a now-stale "empty" verdict for up to GALLERY_LEVEL_EMPTY_
 *  CACHE_SECONDS more. This is a best-effort nicety, not a correctness requirement —
 *  the marker's own short TTL already bounds staleness even if this is never called
 *  for a given combination (e.g. the internal handler does not know every (field,
 *  gradeMode) combination a newly-indexed row might satisfy, so it only clears the
 *  narrow, cheaply-derivable set — see handlers/internalHandlers.ts). */
export async function clearLevelEmpty(params: LevelEmptyKeyParams): Promise<void> {
  const cache = await caches.open(NAMESPACE);
  await cache.delete(levelCacheKey(params));
}