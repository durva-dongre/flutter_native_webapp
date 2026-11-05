async function importKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sign(payload, secret) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), ...payload })));
  const input = `${header}.${body}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export async function verify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [h, p, s] = parts;
  const key = await importKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('invalid_signature');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token_expired');
  return payload;
}

export function issueAccessToken(phone, env) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ phone, type: 'access', exp: now + 7776000 }, env.JWT_SECRET);
}

export function issueResetToken(phone, env) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ phone, type: 'reset', exp: now + 600 }, env.JWT_SECRET);
}

export function bearerToken(request) {
  for (const h of ['X-Flutter-Authorization', 'Authorization']) {
    const v = request.headers.get(h);
    if (v && v.startsWith('Bearer ')) return v.slice(7);
  }
  return null;
}

export async function requireAccess(request, env, expectedPhone) {
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'missing_token' };
  try {
    const payload = await verify(token, env.JWT_SECRET);
    if (payload.type !== 'access') return { ok: false, status: 401, error: 'invalid_token_type' };
    if (expectedPhone && payload.phone !== expectedPhone) return { ok: false, status: 403, error: 'token_phone_mismatch' };
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, status: 401, error: e.message };
  }
}