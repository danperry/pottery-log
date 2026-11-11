/**
 * Pottery Log auth Worker (Cloudflare Workers).
 *
 * The static app can't keep a Google refresh token by itself: browser-only sign-in
 * never issues one, and getting one needs the OAuth client secret. This Worker does
 * the one thing that needs a server, and stores nothing:
 *
 *   GET  /auth/start     Starts Google's authorization-code flow with PKCE
 *                        (access_type=offline, prompt=consent, scope drive.file).
 *   GET  /auth/callback  Exchanges the code for tokens using the client secret,
 *                        encrypts the refresh token with AES-GCM, and redirects back
 *                        to the app with the encrypted blob in the URL fragment.
 *   POST /auth/token     { blob } -> { access_token, expires_in, expires_at }.
 *                        Decrypts the blob and asks Google for a fresh access token.
 *   POST /auth/revoke    { blob } -> { ok }. Revokes the refresh token with Google,
 *                        used by the app's Disconnect button.
 *
 * The refresh token only ever exists in plain form inside this Worker. The app holds
 * the encrypted blob, which is useless without TOKEN_ENC_KEY.
 *
 * Configuration (see README):
 *   APP_URL               var     Full URL of the app, e.g. https://you.github.io/pottery-log/
 *   GOOGLE_CLIENT_ID      secret  OAuth "Web application" client ID
 *   GOOGLE_CLIENT_SECRET  secret  Its client secret
 *   TOKEN_ENC_KEY         secret  32 random bytes, base64 (openssl rand -base64 32)
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const STATE_COOKIE = '__Host-pl_oauth';
const STATE_MAX_AGE = 600; // seconds a sign-in may take
const MAX_BODY = 8192;

// Separate "purposes" so a state value can never be replayed as a token blob or vice versa.
const AAD_STATE = 'pottery-log:state:v1';
const AAD_REFRESH = 'pottery-log:refresh:v1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      checkConfig(env);
      switch (url.pathname) {
        case '/auth/start':
          if (request.method !== 'GET') return text('Method not allowed', 405);
          return await start(request, env);
        case '/auth/callback':
          if (request.method !== 'GET') return text('Method not allowed', 405);
          return await callback(request, env);
        case '/auth/token':
          return await api(request, env, refreshAccessToken);
        case '/auth/revoke':
          return await api(request, env, revoke);
        default:
          return text('Not found', 404);
      }
    } catch (err) {
      console.error(err && err.stack || err);
      return text('Server error', 500);
    }
  },
};

/* ---------- endpoints ---------- */

async function start(request, env) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const state = await seal(env, AAD_STATE, { v: verifier, n: nonce, t: Date.now() });

  const auth = new URL(GOOGLE_AUTH);
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  // The nonce cookie ties the callback to the browser that started sign-in (login CSRF).
  return redirect(auth.toString(), {
    'Set-Cookie': `${STATE_COOKIE}=${nonce}; Max-Age=${STATE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const clearCookie = { 'Set-Cookie': `${STATE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax` };
  const back = (fragment) => redirect(env.APP_URL + '#' + fragment, clearCookie);
  const fail = (code) => back('auth_error=' + encodeURIComponent(code));

  if (url.searchParams.get('error')) return fail(url.searchParams.get('error')); // e.g. access_denied
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  if (!code || !stateParam) return fail('invalid_request');

  const state = await open(env, AAD_STATE, stateParam);
  if (!state) return fail('invalid_state');
  if (Date.now() - state.t > STATE_MAX_AGE * 1000) return fail('expired');
  if (!timingSafeEqual(getCookie(request, STATE_COOKIE) || '', state.n)) return fail('state_mismatch');

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: state.v,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
    }),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) return fail(tokens.error || 'token_exchange_failed');
  if (!tokens.refresh_token) return fail('no_refresh_token');
  if (!String(tokens.scope || '').split(' ').includes(SCOPE)) return fail('scope_not_granted');

  const blob = await seal(env, AAD_REFRESH, { rt: tokens.refresh_token, iat: Date.now() });
  return back('auth=' + blob);
}

async function refreshAccessToken(env, refreshToken) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant: the user revoked access, the token went unused for 6 months,
    // or the consent screen is still in Testing (7-day limit). The app must reconnect.
    if (j.error === 'invalid_grant') return { status: 401, body: { error: 'invalid_grant' } };
    return { status: 502, body: { error: 'upstream_error' } };
  }
  const expiresIn = Number(j.expires_in) || 3600;
  return { status: 200, body: { access_token: j.access_token, expires_in: expiresIn, expires_at: Date.now() + expiresIn * 1000 } };
}

async function revoke(env, refreshToken) {
  const res = await fetch(GOOGLE_REVOKE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
  });
  // A token Google no longer knows is already revoked, which is the outcome we want.
  if (res.ok || res.status === 400) return { status: 200, body: { ok: true } };
  return { status: 502, body: { error: 'upstream_error' } };
}

/** Shared handling for the two JSON endpoints: CORS, origin lock, body parsing, blob decryption. */
async function api(request, env, handler) {
  const allowed = new URL(env.APP_URL).origin;
  const origin = request.headers.get('Origin');
  const cors = {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin !== allowed) return json({ error: 'forbidden_origin' }, 403, { Vary: 'Origin' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too_large' }, 413, cors);
  let blob;
  try { blob = JSON.parse(raw).blob; } catch (e) { /* handled below */ }
  if (typeof blob !== 'string' || !blob) return json({ error: 'invalid_request' }, 400, cors);

  const data = await open(env, AAD_REFRESH, blob);
  // An unreadable blob (tampered, or TOKEN_ENC_KEY was rotated) can't be recovered: reconnect.
  if (!data || !data.rt) return json({ error: 'invalid_grant' }, 401, cors);

  const out = await handler(env, data.rt);
  return json(out.body, out.status, cors);
}

/* ---------- crypto: AES-GCM sealed JSON ---------- */

let keyCache = null;
async function key(env) {
  if (keyCache && keyCache.raw === env.TOKEN_ENC_KEY) return keyCache.key;
  const bytes = Uint8Array.from(atob(env.TOKEN_ENC_KEY.trim()), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
  const k = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  keyCache = { raw: env.TOKEN_ENC_KEY, key: k };
  return k;
}

/** Encrypt an object -> "v1.<base64url(iv | ciphertext+tag)>". */
async function seal(env, aad, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad) }, await key(env), utf8(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return 'v1.' + b64url(out);
}

/** Decrypt a sealed value; returns null if it is malformed, tampered with, or for another purpose. */
async function open(env, aad, sealed) {
  try {
    if (!sealed.startsWith('v1.') || sealed.length > MAX_BODY) return null;
    const bytes = fromB64url(sealed.slice(3));
    if (bytes.length < 12 + 16) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8(aad) }, await key(env), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    return null;
  }
}

/* ---------- helpers ---------- */

function checkConfig(env) {
  for (const k of ['APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENC_KEY']) {
    if (!env[k]) throw new Error('Missing Worker setting: ' + k);
  }
}

function redirectUri(request) {
  return new URL('/auth/callback', request.url).toString();
}

function utf8(s) { return new TextEncoder().encode(s); }

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...SECURITY_HEADERS, ...headers } });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS, ...headers },
  });
}

function text(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...SECURITY_HEADERS } });
}
