/**
 * handlers/chatHandlers.ts — /tapbuddy/chat.
 * `context` here is the freeform per-screen object forwarded to the AI
 * provider via the ChatSession Durable Object; unrelated to the
 * "program"|"event" context field used on progress/submission routes.
 *
 * FIX: analytics threaded through, passed into enforceRateLimit, and
 * noteDurableObject("ChatSession") called so durableObjectClass stops
 * being permanently null in Analytics Engine.
 */

import { requireStudentToken } from "../auth/middleware";
import type { Env } from "../env";
import { invalidInput, upstreamError } from "../env";
import { ok } from "../util/errors";
import { enforceRateLimit } from "../util/rateLimit";
import { collectTelemetry } from "../telemetry/collector";
import type { RequestAnalyticsContext } from "../router";

const ROUTE_CHAT = "/tapbuddy/chat";

interface ChatBody { message?: string; context?: Record<string, unknown>; _t?: unknown; }

async function chat(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  setStudentId: (sid: string) => void,
  analytics: RequestAnalyticsContext
): Promise<Response> {
  const { studentId } = await requireStudentToken(req, env);
  setStudentId(studentId);
  await enforceRateLimit(env, studentId, "chat", ROUTE_CHAT, analytics);

  const body = (await req.json().catch(() => ({}))) as ChatBody;
  if (!body.message || typeof body.message !== "string" || body.message.trim().length === 0) {
    throw invalidInput("message missing or empty");
  }

  const sessionId = req.headers.get("X-Chat-Session") ?? `${studentId}:default`;

  const id = env.CHAT_SESSION.idFromName(sessionId);
  const stub = env.CHAT_SESSION.get(id);
  analytics.noteDurableObject("ChatSession");

  const res = await stub.fetch("https://do.internal/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, studentId, message: body.message, context: body.context ?? {} }),
  });

  if (!res.ok) {
    throw upstreamError("AI provider call failed — safe to retry");
  }
  const { reply } = (await res.json()) as { reply: string };

  ctx.waitUntil(collectTelemetry(env, studentId, body._t).catch(() => {}));

  return ok({ reply });
}

export const chatHandlers = { chat };