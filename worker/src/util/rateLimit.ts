/**
 * util/rateLimit.ts — Cache API burst limiting (eventually consistent, per-location —
 * the right trade for abuse control at this scale, not exact accounting) plus, where a
 * route has a configured per-turn budget, the turn-budget check.
 *
 * enforceRateLimit optionally takes a RequestAnalyticsContext so the burst-remaining
 * count and the turn-budget-used count are actually recorded into Analytics Engine
 * instead of always reading back as null — both fields exist on
 * RequestAnalyticsContext specifically to carry this.
 *
 * BUGFIX: previously NO caller anywhere in handlers/*.ts actually passed `routePath`
 * or `analytics` into this function — every call site stopped at
 * `enforceRateLimit(env, studentId, routeClass)`, so the turn-budget branch below
 * (`if (routePath && routePath in cfg.TURN_BUDGETS)`) was unreachable code in
 * practice, and `analytics.noteRateLimit`/`noteTurnBudget` were never invoked. This
 * function's own logic was already correct; the fix is in every handler's call site
 * (handlers/*.ts), which now passes both of these arguments through.
 *
 * Turn budget is checked only for a route path listed in cfg.TURN_BUDGETS (identity
 * is per calling student per route, within TURN_WINDOW_SECONDS) — a route with no
 * configured budget is unaffected and behaves exactly as before.
 */

import { checkBurst } from "../cache/rateLimitCache";
import { checkAndIncrementTurn } from "../cache/turnBudget";
import type { Env, RouteClass } from "../env";
import { rateLimited } from "../env";
import { config } from "../config/index";
import type { RequestAnalyticsContext } from "../router";

export async function enforceRateLimit(
  env: Env,
  studentId: string,
  routeClass: RouteClass,
  routePath?: string,
  analytics?: RequestAnalyticsContext
): Promise<void> {
  const cfg = config(env, env as unknown as Record<string, string>);

  const burst = await checkBurst(studentId, routeClass, cfg.RATE_LIMITS);
  analytics?.noteRateLimit(burst.remaining);
  if (!burst.allowed) {
    throw rateLimited(`rate limit exceeded for ${routeClass}`);
  }

  if (routePath && routePath in cfg.TURN_BUDGETS) {
    const turn = await checkAndIncrementTurn(
      studentId,
      routePath,
      cfg.TURN_BUDGETS,
      cfg.DEFAULT_TURN_BUDGET,
      cfg.TURN_WINDOW_SECONDS
    );
    analytics?.noteTurnBudget(turn.count);
    if (!turn.allowed) {
      throw rateLimited(`turn budget exceeded for ${routePath}`);
    }
  }
}