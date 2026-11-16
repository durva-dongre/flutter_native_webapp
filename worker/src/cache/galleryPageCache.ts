/**
 * cache/galleryPageCache.ts — keyed from EVERY value that affects the query result, so
 * a cache key missing a dimension can never poison the cache for a different caller.
 *
 * `generation` is the Worker's own gallery_cache_generation counter (D1 app_config,
 * bumped unconditionally every night by internalHandlers.ts::knownIds). Folding it
 * into the key means every page cached under a prior generation becomes permanently
 * unreachable the moment the counter bumps — no explicit invalidation sweep needed,
 * old entries just expire naturally via their own Cache-Control max-age.
 */

import type { GalleryPage } from "../db/gallery";
import type { ConfigSchema } from "../config/defaults";

const NAMESPACE = "gallery-page";

export interface GalleryCacheKeyParams {
  scopeMode: "assignment" | "school_grade";
  assignmentId?: string;
  state: string;
  district: string;
  school: string;
  grade: number;
  limit: number;
  cursor: number | null;
  generation: number;
}

function cacheKeyFor(params: GalleryCacheKeyParams): Request {
  const parts = [
    params.scopeMode,
    params.assignmentId ?? "-",
    params.state,
    params.district,
    params.school,
    String(params.grade),
    String(params.limit),
    params.cursor === null ? "start" : String(params.cursor),
    String(params.generation),
  ].map(encodeURIComponent);
  return new Request(`https://gallery-page.internal/${parts.join("/")}`);
}

export async function getCachedGalleryPage(params: GalleryCacheKeyParams): Promise<GalleryPage | null> {
  const cache = await caches.open(NAMESPACE);
  const hit = await cache.match(cacheKeyFor(params));
  return hit ? ((await hit.json()) as GalleryPage) : null;
}

export async function putCachedGalleryPage(
  params: GalleryCacheKeyParams,
  page: GalleryPage,
  cfg: Pick<ConfigSchema, "GALLERY_PAGE_CACHE_SECONDS">
): Promise<void> {
  if (cfg.GALLERY_PAGE_CACHE_SECONDS <= 0) return;
  const cache = await caches.open(NAMESPACE);
  await cache.put(
    cacheKeyFor(params),
    new Response(JSON.stringify(page), { headers: { "Cache-Control": `max-age=${cfg.GALLERY_PAGE_CACHE_SECONDS}` } })
  );
}