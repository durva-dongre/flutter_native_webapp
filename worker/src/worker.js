import { requireAccess, issueAccessToken, issueResetToken, verify, bearerToken } from './auth.js';
import { handleTapbuddyChat, handleSubmissionReview } from './ai.js';
import { handleGallery } from './gallery.js';

const AUTH_ROUTES = {
  'POST /auth/check-phone': { target: 'tap_lms.tapapp.api.auth.tapapp_auth.check_phone', bucket: 'default' },
  'POST /auth/login': { target: 'tap_lms.tapapp.api.auth.tapapp_auth.login_with_password', bucket: 'default', issueToken: true },
  'POST /auth/forgot-password/send-otp': { target: 'tap_lms.tapapp.api.auth.tapapp_auth.forgot_password_send_otp', bucket: 'otp' },
  'POST /auth/forgot-password/verify-otp': { target: 'tap_lms.tapapp.api.auth.tapapp_auth.forgot_password_verify_otp', bucket: 'otp', issueResetToken: true },
  'POST /auth/reset-password': { target: 'tap_lms.tapapp.api.auth.tapapp_auth.reset_password', bucket: 'default', requireReset: true },
};

const RATE_LIMITS = {
  otp: { limit: 5, windowSeconds: 3600 },
  groq: { limit: 20, windowSeconds: 3600 },
  default: { limit: 60, windowSeconds: 60 },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '*').trim();
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Flutter-Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed === '*') headers['Access-Control-Allow-Origin'] = origin || '*';
  else if (origin && allowed.split(',').map((o) => o.trim()).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request, env);
  for (const k in cors) headers.set(k, cors[k]);
  return new Response(response.body, { status: response.status, headers });
}

async function checkRateLimit(env, bucket, ip) {
  if (!env.KV) return true;
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const key = `rl:${bucket}:${ip}`;
  const current = await env.KV.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= limit) return false;
  await env.KV.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}

async function proxyAuthRoute(route, request, env) {
  const body = await request.json().catch(() => ({}));

  if (route.requireReset) {
    const token = bearerToken(request);
    if (!token) return json({ success: false, error: 'missing_token' }, 401);
    try {
      const payload = await verify(token, env.JWT_SECRET);
      if (payload.type !== 'reset') return json({ success: false, error: 'invalid_token_type' }, 401);
      body.phone = payload.phone;
    } catch (e) {
      return json({ success: false, error: e.message }, 401);
    }
  }

  const backendResp = await fetch(`${env.FRAPPE_BASE_URL}/api/method/${route.target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await backendResp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const result = parsed && Object.prototype.hasOwnProperty.call(parsed, 'message') ? parsed.message : parsed || { success: backendResp.ok, raw: text };

  if (backendResp.ok && route.issueToken && result.phone) result.token = await issueAccessToken(result.phone, env);
  if (backendResp.ok && route.issueResetToken && body.phone) result.reset_token = await issueResetToken(body.phone, env);

  return json(result, backendResp.status);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const routeKey = `${request.method} ${url.pathname}`;

    try {
      if (routeKey === 'POST /tapbuddy/chat') {
        if (!(await checkRateLimit(env, 'groq', ip))) return withCors(json({ success: false, error: 'rate_limited' }, 429), request, env);
        return withCors(await handleTapbuddyChat(request, env), request, env);
      }
      if (routeKey === 'POST /submission-review/review') {
        if (!(await checkRateLimit(env, 'groq', ip))) return withCors(json({ success: false, error: 'rate_limited' }, 429), request, env);
        return withCors(await handleSubmissionReview(request, env), request, env);
      }
      if (routeKey === 'GET /gallery') {
        return withCors(await handleGallery(request, env, ctx), request, env);
      }

      const route = AUTH_ROUTES[routeKey];
      if (route) {
        if (!(await checkRateLimit(env, route.bucket, ip))) return withCors(json({ success: false, error: 'rate_limited' }, 429), request, env);
        return withCors(await proxyAuthRoute(route, request, env), request, env);
      }

      return withCors(json({ success: false, error: 'not_found' }, 404), request, env);
    } catch (err) {
      return withCors(json({ success: false, error: 'internal_error', detail: err.message }, 500), request, env);
    }
  },
};