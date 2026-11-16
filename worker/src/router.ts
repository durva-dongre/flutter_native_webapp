import { authHandlers } from "./handlers/authHandlers";
import { profileHandlers } from "./handlers/profileHandlers";
import { progressHandlers } from "./handlers/progressHandlers";
import { submissionHandlers } from "./handlers/submissionHandlers";
import { galleryHandlers } from "./handlers/galleryHandlers";
import { chatHandlers } from "./handlers/chatHandlers";
import { eventHandlers } from "./handlers/eventHandlers";
import { telemetryHandlers } from "./handlers/telemetryHandlers";
import { laterHandlers } from "./handlers/laterHandlers";
import { internalHandlers } from "./handlers/internalHandlers";
import { configHandlers } from "./handlers/configHandlers";
import { writeAnalyticsPoint, sanitizeQueryStringForAnalytics } from "./analytics/engine";
import { failFromAppError, fail } from "./util/errors";
import { AppError, type Env } from "./env";

/**
 * BUGFIX (router-level analytics wiring): previously, every RouteDefinition.handler
 * was typed to accept a 5th `analytics: RequestAnalyticsContext` argument, and this
 * file dutifully constructed one (createAnalyticsContext) and passed it into every
 * handler call — but NOT ONE actual handler function anywhere in handlers/*.ts
 * declared a 5th parameter to receive it. TypeScript's structural typing happily
 * allowed a 4-parameter function to satisfy the 5-parameter RouteDefinition.handler
 * type (extra call-site arguments are simply ignored), so this compiled cleanly while
 * silently dropping the analytics object on every single request.

 * The practical effect: `frappeMethodCalled`, `frappeCallCount`, `durableObjectClass`,
 * `rateLimitRemaining`, `turnBudgetUsed`, and `idempotencyRepeat` were ALWAYS written
 * to Analytics Engine as null/unset — an entire analytics-enrichment subsystem was
 * fully wired up on the write side (writeAnalyticsPoint below) and fully inert on the
 * populate side. This also meant the configured per-route turn budgets
 * (ConfigSchema.TURN_BUDGETS) were never actually CHECKED either, since
 * util/rateLimit.ts::enforceRateLimit only runs its turn-budget branch when a caller
 * passes both `routePath` and `analytics` — and no handler was doing that.
 *
 * Fix: every handler in handlers/*.ts is updated to accept `analytics` as its 5th
 * parameter and to use it — passing it (with the route's own path) into
 * enforceRateLimit, and calling analytics.noteFrappeCall / noteDurableObject /
 * noteIdempotencyRepeat around the relevant calls. This file's own plumbing
 * (createAnalyticsContext, the call to def.handler, and writeAnalyticsPoint) was
 * already correct and needs no change — the fix lives in the handlers themselves,
 * matching this router's own already-correct contract.
 */

export interface RouteDefinition {
  method: "GET" | "POST";
  path: string;
  routeClass: "write" | "read" | "chat" | "telemetry" | "auth";
  handler: (
    req: Request,
    env: Env,
    ctx: ExecutionContext,
    setStudentId: (sid: string) => void,
    analytics: RequestAnalyticsContext
  ) => Promise<Response>;
}

export interface RequestAnalyticsContext {
  frappeMethodCalled: string | null;
  frappeCallCount: number;
  durableObjectClass: string | null;
  rateLimitRemaining: number | null;
  turnBudgetUsed: number | null;
  idempotencyRepeat: boolean | null;
  noteFrappeCall(method: string): void;
  noteDurableObject(className: string): void;
  noteRateLimit(remaining: number): void;
  noteTurnBudget(used: number): void;
  noteIdempotencyRepeat(repeat: boolean): void;
}

export function createAnalyticsContext(): RequestAnalyticsContext {
  const ctx: RequestAnalyticsContext = {
    frappeMethodCalled: null,
    frappeCallCount: 0,
    durableObjectClass: null,
    rateLimitRemaining: null,
    turnBudgetUsed: null,
    idempotencyRepeat: null,
    noteFrappeCall(method: string) {
      ctx.frappeMethodCalled = method;
      ctx.frappeCallCount += 1;
    },
    noteDurableObject(className: string) {
      ctx.durableObjectClass = className;
    },
    noteRateLimit(remaining: number) {
      ctx.rateLimitRemaining = remaining;
    },
    noteTurnBudget(used: number) {
      ctx.turnBudgetUsed = used;
    },
    noteIdempotencyRepeat(repeat: boolean) {
      ctx.idempotencyRepeat = repeat;
    },
  };
  return ctx;
}

// NOTE: "skip" no longer exists as its own route. /submission/do_later is the single
// route for "move past this assignment without submitting" — it's a server-side no-op
// (see handlers/laterHandlers.ts), not a listed/removable item, so there's no
// later_list or do_later_remove route either.
//
// /internal/gallery/* routes are called only by Frappe's nightly
// gallery_promotion_sweep job, never by the app — all three (index, visibility,
// known_ids) share the same internal-secret auth and "write" routeClass.
const ROUTES: RouteDefinition[] = [
  { method: "POST", path: "/auth/redeem", routeClass: "auth", handler: authHandlers.redeem },
  { method: "POST", path: "/auth/select_profile", routeClass: "auth", handler: authHandlers.selectProfile },
  { method: "POST", path: "/profile/get_profile", routeClass: "read", handler: profileHandlers.getProfile },
  { method: "POST", path: "/progress/submit_video_watched", routeClass: "write", handler: progressHandlers.submitVideoWatched },
  { method: "POST", path: "/progress/submit_quiz", routeClass: "write", handler: progressHandlers.submitQuiz },
  { method: "POST", path: "/progress/sync", routeClass: "read", handler: progressHandlers.sync },
  { method: "POST", path: "/progress/last_submission", routeClass: "read", handler: progressHandlers.lastSubmission },
  { method: "POST", path: "/submission/request_upload", routeClass: "write", handler: submissionHandlers.requestUpload },
  { method: "POST", path: "/submission/submit_artwork", routeClass: "write", handler: submissionHandlers.submitArtwork },
  { method: "POST", path: "/submission/list", routeClass: "read", handler: submissionHandlers.list },
  { method: "POST", path: "/submission/get", routeClass: "read", handler: submissionHandlers.get },
  { method: "POST", path: "/submission/do_later", routeClass: "write", handler: laterHandlers.doLater },
  { method: "GET", path: "/gallery", routeClass: "read", handler: galleryHandlers.gallery },
  { method: "GET", path: "/app/config", routeClass: "read", handler: configHandlers.appConfig as RouteDefinition["handler"] },
  { method: "POST", path: "/telemetry/flush", routeClass: "telemetry", handler: telemetryHandlers.flush },
  { method: "POST", path: "/tapbuddy/chat", routeClass: "chat", handler: chatHandlers.chat },
  { method: "POST", path: "/events/enroll", routeClass: "write", handler: eventHandlers.enroll },
  { method: "POST", path: "/events/is_enrolled", routeClass: "write", handler: eventHandlers.isEnrolled },
  {
    method: "POST",
    path: "/internal/gallery/index",
    routeClass: "write",
    handler: internalHandlers.indexBatch as RouteDefinition["handler"],
  },
  {
    method: "POST",
    path: "/internal/gallery/visibility",
    routeClass: "write",
    handler: internalHandlers.visibility as RouteDefinition["handler"],
  },
  {
    method: "POST",
    path: "/internal/gallery/known_ids",
    routeClass: "write",
    handler: internalHandlers.knownIds as RouteDefinition["handler"],
  },
];

function matchRoute(req: Request): { def: RouteDefinition; path: string } | null {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const def = ROUTES.find((r) => r.method === req.method && r.path === path);
  return def ? { def, path } : null;
}

export async function handleRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const matched = matchRoute(req);

  if (!matched) return fail("NOT_FOUND", "No such route.", 404);
  const { def, path } = matched;

  const url = new URL(req.url);
  const analytics = createAnalyticsContext();

  let studentId: string | null = null;
  let outcome: "ok" | "error" = "ok";
  let errorCode: string | null = null;
  let response: Response;

  const requestContentType = req.headers.get("content-type");
  const requestContentLength = req.headers.get("content-length");
  const requestBodyBytes = requestContentLength !== null ? Number(requestContentLength) : null;

  try {
    response = await def.handler(
      req,
      env,
      ctx,
      (sid) => {
        studentId = sid;
      },
      analytics
    );
  } catch (err) {
    outcome = "error";
    if (err instanceof AppError) {
      errorCode = err.code;
      response = failFromAppError(err);
    } else {
      errorCode = "SERVER_ERROR";
      console.error(`[router] unhandled error on ${path}`, err);
      response = fail("SERVER_ERROR", "Internal server error.", 500);
    }
  }

  const cf = (req as Request & { cf?: Record<string, unknown> }).cf;
  const responseContentType = response!.headers.get("content-type");
  const responseContentLength = response!.headers.get("content-length");
  const responseBodyBytes = responseContentLength !== null ? Number(responseContentLength) : null;

  ctx.waitUntil(
    (async () => {
      writeAnalyticsPoint(env, {
        path,
        routeClass: def.routeClass,
        studentId,
        outcome,
        errorCode,
        httpMethod: req.method,
        httpStatus: response!.status,
        colo: (cf?.colo as string) ?? null,
        tlsVersion: (cf?.tlsVersion as string) ?? null,
        httpProtocol: (cf?.httpProtocol as string) ?? null,
        asOrganization: (cf?.asOrganization as string) ?? null,
        cacheStatus: response!.headers.get("cf-cache-status"),
        requestContentType,
        responseContentType,
        idempotencyRepeat: analytics.idempotencyRepeat,
        rayId: req.headers.get("cf-ray"),
        queryString: sanitizeQueryStringForAnalytics(url.search),
        frappeMethodCalled: analytics.frappeMethodCalled,
        frappeCallCount: analytics.frappeCallCount > 0 ? analytics.frappeCallCount : null,
        durableObjectClass: analytics.durableObjectClass,
        requestBodyBytes,
        responseBodyBytes,
        rateLimitRemaining: analytics.rateLimitRemaining,
        turnBudgetUsed: analytics.turnBudgetUsed,
      });
    })()
  );

  return response!;
}