import { AwsClient } from 'aws4fetch';

function slug(v) {
  return String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildPrefix({ event_id, state, district, school, grade }) {
  if (!event_id || !state) return null;
  const segs = [`public/${event_id}`, slug(state)];
  if (district) segs.push(slug(district));
  if (district && school) segs.push(slug(school));
  if (district && school && grade) segs.push(`grade-${grade}`);
  return segs.join('/') + '/';
}

function fallbackLevels(params) {
  const { event_id, state, district, school, grade } = params;
  const candidates = [
    { name: 'class', prefix: buildPrefix({ event_id, state, district, school, grade }) },
    { name: 'school', prefix: buildPrefix({ event_id, state, district, school }) },
    { name: 'district', prefix: buildPrefix({ event_id, state, district }) },
    { name: 'state', prefix: buildPrefix({ event_id, state }) },
  ];
  const seen = new Set();
  const levels = [];
  for (const c of candidates) {
    if (!c.prefix || seen.has(c.prefix)) continue;
    seen.add(c.prefix);
    levels.push(c);
  }
  return levels;
}

async function listWithFallback(env, params, limit, cursor, forcedLevel) {
  const levels = fallbackLevels(params);
  if (forcedLevel) {
    const level = levels.find((l) => l.name === forcedLevel) || levels[0];
    const listed = await env.R2.list({ prefix: level.prefix, limit, cursor: cursor || undefined });
    return { matched_level: level.name, used_prefix: level.prefix, objects: listed.objects, truncated: listed.truncated, cursor: listed.truncated ? listed.cursor : null };
  }
  for (const level of levels) {
    const listed = await env.R2.list({ prefix: level.prefix, limit });
    if (listed.objects.length > 0) {
      return { matched_level: level.name, used_prefix: level.prefix, objects: listed.objects, truncated: listed.truncated, cursor: listed.truncated ? listed.cursor : null };
    }
  }
  return { matched_level: 'none', used_prefix: levels[0]?.prefix ?? null, objects: [], truncated: false, cursor: null };
}

function r2Client(env) {
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY });
}

async function signR2GetUrl(env, client, key) {
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`);
  url.searchParams.set('X-Amz-Expires', env.R2_SIGN_TTL_SECONDS || '604800');
  const signed = await client.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
  return signed.url;
}

async function getCachedSignedUrl(env, ctx, client, key) {
  const cacheKey = new Request(`https://r2-sign-cache.internal/${key}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return (await cached.json()).url;
  const url = await signR2GetUrl(env, client, key);
  const response = new Response(JSON.stringify({ url, signedAt: Date.now() }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${env.GALLERY_CACHE_TTL_SECONDS || '86400'}` },
  });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return url;
}

function json(data, status, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheSeconds) headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(data), { status, headers });
}

export async function handleGallery(request, env, ctx) {
  const url = new URL(request.url);
  const q = Object.fromEntries(url.searchParams);
  if (!q.event_id || !q.state) return json({ success: false, error: 'event_id_and_state_required' }, 400);

  const defaultLimit = parseInt(env.GALLERY_DEFAULT_LIMIT || '50', 10);
  const maxLimit = parseInt(env.GALLERY_MAX_LIMIT || '100', 10);
  const limit = Math.min(parseInt(q.limit, 10) || defaultLimit, maxLimit);
  const cacheTtl = parseInt(env.GALLERY_CACHE_TTL_SECONDS || '86400', 10);

  const cache = caches.default;
  const respCacheKey = new Request(url.toString());
  const cached = await cache.match(respCacheKey);
  if (cached) return cached;

  const listed = await listWithFallback(env, q, limit, q.cursor || null, q.level || null);
  const client = r2Client(env);
  const images = await Promise.all(
    listed.objects.map(async (obj) => ({ key: obj.key, uploaded: obj.uploaded, url: await getCachedSignedUrl(env, ctx, client, obj.key) }))
  );

  const body = {
    event_id: q.event_id,
    requested: { state: q.state, district: q.district || null, school: q.school || null, grade: q.grade || null },
    matched_level: listed.matched_level,
    used_prefix: listed.used_prefix,
    fallback_applied: !q.level && listed.matched_level !== 'class',
    level: listed.matched_level,
    limit,
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
    images,
  };

  const response = json(body, 200, cacheTtl);
  ctx.waitUntil(cache.put(respCacheKey, response.clone()));
  return response;
}