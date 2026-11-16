/**
 * frappe/client.ts 
 *
 * mapFrappeError rewritten to stop throwing away information:
 *  - 401 and 403 no longer collapse into a retryable UPSTREAM_ERROR (502). A bad/
 *    expired credential (401) and a real permission denial (403) are both
 *    permanent failures -- they will fail identically on every retry -- so they
 *    now map to `unauthorized`/`forbidden` respectively, non-retryable.
 *  - Frappe's real `message` is now forwarded as the client-visible message
 *    instead of being discarded (404/409) or having the error_code jammed into
 *    it in its place (400). Frappe's own error_code rides along separately as
 *    `subCode` on the AppError, which util/errors.ts serializes as `sub_code`
 *    on the wire -- so the client gets a real sentence AND a stable machine
 *    code, never one masquerading as the other.
 *  - The dead `417` branch is removed -- Frappe never returns 417 anywhere in
 *    this codebase.
 */

import {
  upstreamError, studentNotFound, notFound, conflict, invalidInput,
  serverError, unauthorized, forbidden,
} from "../env";

interface FrappeEnv {
  FRAPPE_BASE_URL: string;
  FRAPPE_API_KEY: string;
  FRAPPE_API_SECRET: string;
}

const FRAPPE_TIMEOUT_MS = 8000;

const RETRYABLE_READ_METHODS = new Set([
  "get_profile",
  "progress_sync",
  "last_submission",
  "check_attempt_cap",
  "list_submissions",
  "get_submission",
  "get_profile_scope",
  "is_enrolled",
]);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface FrappeErrorBody {
  error_code?: string;
  message?: string;
}

async function mapFrappeError(res: Response): Promise<never> {
  let body: FrappeErrorBody = {};
  try {
    body = (await res.json()) as FrappeErrorBody;
  } catch {
    // unparseable body -- fall through to a status-only mapping below
  }
  const code = body.error_code ?? "";
  const message = body.message && body.message.trim() ? body.message : null;

  if (res.status === 404) {
    throw notFound(message ?? "The requested resource was not found.", code || undefined);
  }
  if (res.status === 409) {
    throw conflict(message ?? "This action has already reached its limit.", code || undefined);
  }
  if (res.status === 403) {
    // Real, permanent permission denial -- never "safe to retry".
    throw forbidden(message ?? "You do not have permission to do this.", code || undefined);
  }
  if (res.status === 401) {
    // Real, permanent auth failure -- never "safe to retry".
    throw unauthorized(message ?? "Authentication failed.", code || undefined);
  }
  if (res.status === 400) {
    if (code === "student_not_found") throw studentNotFound(message ?? undefined);
    throw invalidInput(message ?? "Invalid input.", code || undefined);
  }
  if (res.status >= 500) {
    throw upstreamError("Upstream service error — safe to retry.");
  }
  throw serverError();
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 150);
}

export async function fetchFrappe<T = Record<string, unknown>>(
  env: FrappeEnv,
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const url = `${env.FRAPPE_BASE_URL}/api/method/${method}`;
  const timeoutMs = opts.timeoutMs ?? FRAPPE_TIMEOUT_MS;
  const methodName = method.split(".").pop() ?? method;
  const canRetry = RETRYABLE_READ_METHODS.has(methodName);
  const maxAttempts = canRetry ? 2 : 1;

  let lastNetworkError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, jitter(200)));

      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `token ${env.FRAPPE_API_KEY}:${env.FRAPPE_API_SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(params),
        },
        timeoutMs
      );

      if (!res.ok) {
        if (res.status >= 500 && canRetry && attempt < maxAttempts - 1) continue;
        return mapFrappeError(res);
      }

      const json = (await res.json()) as { message?: T } | T;
      return (json as { message?: T }).message !== undefined ? (json as { message: T }).message : (json as T);
    } catch (err) {
      lastNetworkError = err;
      if (canRetry && attempt < maxAttempts - 1) continue;
    }
  }

  throw upstreamError(
    `Frappe call to ${method} failed: ${lastNetworkError instanceof Error ? lastNetworkError.message : "network error"}`
  );
}