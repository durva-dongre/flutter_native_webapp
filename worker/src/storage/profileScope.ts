/**
 * storage/profileScope.ts — Frappe is the scope authority for gallery (Contract §1.2).
 * Called only when the app's scope_cache_token is missing/expired/malformed; cached in
 * the Worker Cache API for PROFILE_SCOPE_TTL_SECONDS (now 1 day) so a day's worth of
 * gallery opens across a whole school never re-hits Frappe for the same student.
 *
 * v6 change: now also carries assignment_id — the student's current/default
 * assignment, resolved server-side by Frappe (tap_lms/shared/profile/student.py) from
 * their current learning unit. galleryHandlers.ts uses this as the default gallery
 * scope when the client doesn't pass one explicitly, so most requests land on the
 * narrowest (assignment_id) level of the fallback cascade on the first try instead of
 * relying on it being supplied by the client or falling back to location scoping.
 *
 * v7 fix — null-safe scope normalization:
 * Frappe's get_profile_scope (tap_lms/shared/profile/student.py) returns state_id/
 * district_id as a real `null` whenever a student has no state/district recorded —
 * this is normal, expected data, not an error on Frappe's side. normalizeScopeValue
 * previously declared its parameter as `string` and called `.trim()` on it directly;
 * that signature was never actually enforced at the JSON-deserialization boundary, so
 * a student profile with null state_id/district_id reached `.trim()` on a real `null`
 * at runtime and crashed the whole /gallery request with an unhandled TypeError,
 * regardless of which fallback level the gallery cascade would otherwise have used.
 * normalizeScopeValue's parameter type now reflects what Frappe can actually send
 * (string | null | undefined), and a missing value normalizes to "" rather than
 * throwing — an empty-string state/district then simply matches no gallery_items row
 * at that cascade level (see db/gallery.ts's queryLevel), so the cascade degrades
 * gracefully to the next configured level, or to an empty gallery page, instead of
 * 500ing the endpoint outright.
 */

import { fetchFrappe } from "../frappe/client";
import { FRAPPE_METHODS } from "../frappe/mapRequest";
import type { ConfigSchema } from "../config/defaults";
import type { Env } from "../env";

const CACHE_NAMESPACE = "profile-scope";

export function normalizeScopeValue(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

export interface ProfileScope {
  state: string;
  district: string;
  school: string;
  grade: number;
  /** The student's current/default assignment, as resolved by Frappe. null when the
   *  student has no active enrollment, no current unit, or that unit has no
   *  assignment configured — the gallery's fallback cascade then starts at the next
   *  configured level (school, by default). Not normalized/lowercased — assignment
   *  ids are case-sensitive identifiers (e.g. "CAATA3-U01-A01"). */
  assignmentId: string | null;
}

interface FrappeProfileScopeResult {
  state_id: string | null;
  district_id: string | null;
  school_id: string | null;
  grade: string | number;
  assignment_id?: string | null;
}

export async function getProfileScope(
  env: Env,
  cfg: Pick<ConfigSchema, "PROFILE_SCOPE_TTL_SECONDS">,
  studentId: string
): Promise<ProfileScope> {
  const cache = await caches.open(CACHE_NAMESPACE);
  const cacheKey = new Request(`https://profile-scope.internal/${encodeURIComponent(studentId)}`);

  const cached = await cache.match(cacheKey);
  if (cached) return (await cached.json()) as ProfileScope;

  const raw = await fetchFrappe<FrappeProfileScopeResult>(env, FRAPPE_METHODS.getProfileScope, {
    student_id: studentId,
  });

  const scope: ProfileScope = {
    state: normalizeScopeValue(raw.state_id),
    district: normalizeScopeValue(raw.district_id),
    school: normalizeScopeValue(raw.school_id),
    grade: Number(raw.grade),
    assignmentId: raw.assignment_id && raw.assignment_id.trim() ? raw.assignment_id.trim() : null,
  };

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(scope), { headers: { "Cache-Control": `max-age=${cfg.PROFILE_SCOPE_TTL_SECONDS}` } })
  );

  return scope;
}