import type { RouteClass } from "../env";
import type { RateLimitRule } from "../config/defaults";

const NAMESPACE = "rate-limit";

export interface BurstCheckResult {
  allowed: boolean;
  /** Remaining calls in the current window after this check, clamped to 0. Lets
   *  callers (util/rateLimit.ts) report a real number into request analytics instead
   *  of leaving rateLimitRemaining permanently null. */
  remaining: number;
}

export async function checkBurst(
  key: string,
  routeClass: RouteClass,
  rateLimits: Readonly<Record<RouteClass, RateLimitRule>>
): Promise<BurstCheckResult> {
  const limit = rateLimits[routeClass];
  const cache = await caches.open(NAMESPACE);
  const windowStart = Math.floor(Date.now() / 1000 / limit.windowSeconds);
  const cacheKey = new Request(`https://rl.internal/${routeClass}/${encodeURIComponent(key)}/${windowStart}`);

  const hit = await cache.match(cacheKey);
  const count = hit ? Number(await hit.text()) : 0;
  if (count >= limit.max) return { allowed: false, remaining: 0 };

  await cache.put(cacheKey, new Response(String(count + 1), { headers: { "Cache-Control": `max-age=${limit.windowSeconds}` } }));
  return { allowed: true, remaining: Math.max(limit.max - (count + 1), 0) };
}