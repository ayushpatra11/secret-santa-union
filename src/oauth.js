// "Sign in with Google" and "Sign in with Apple" (OpenID Connect, authorization-code flow).
//
// Security measures:
//   * PKCE (S256), a random `state` and an OIDC `nonce` on every attempt
//   * state is stored server-side (hashed), is single-use, expires in 10 minutes and is
//     bound to a random cookie in the browser that started the login
//   * the ID token is fetched directly from the provider's token endpoint over TLS using
//     our client secret (OIDC Core 3.1.3.7), and we still check iss / aud / exp / nonce
//   * we only accept emails the provider marks as verified
//   * redirect_uri is built from APP_URL, never from the request's Host header

import { ConfigError, hmac, randomToken } from './crypto.js';
import { HttpError } from './http.js';

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    configured: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    clientId: (env) => env.GOOGLE_CLIENT_ID,
  },
  apple: {
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    issuers: ['https://appleid.apple.com'],
    configured: (env) => !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
    clientId: (env) => env.APPLE_CLIENT_ID,
  },
};

export const BINDING_COOKIE = '__Host-ss_oauth';

export function configuredProviders(env) {
  return Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].configured(env));
}

/**
 * Local development and the browser tests can't sign in to real Google, so they point
 * "Google" at a fake provider (e2e/fake-oidc.js) via DEV_OAUTH_BASE. This is refused
 * unless the site itself runs on localhost, so it can never be switched on in production.
 */
function devOverride(env, name) {
  if (!env.DEV_OAUTH_BASE || name !== 'google') return null;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.APP_URL || '')) {
    throw new ConfigError('DEV_OAUTH_BASE is only allowed when APP_URL is localhost.');
  }
  const base = env.DEV_OAUTH_BASE.replace(/\/+$/, '');
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new ConfigError('DEV_OAUTH_BASE must be a localhost URL.');
  return { authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, issuers: [base] };
}

function getProvider(env, name) {
  const p = PROVIDERS[name];
  if (!p || !p.configured(env)) throw new HttpError(404, 'This sign-in method is not enabled');
  const dev = devOverride(env, name);
  return dev ? { ...p, ...dev } : p;
}

function appUrl(env) {
  if (!env.APP_URL) throw new HttpError(500, 'APP_URL is not configured');
  return env.APP_URL.replace(/\/+$/, '');
}

export function redirectUri(env, name) {
  return `${appUrl(env)}/api/auth/oauth/${name}/callback`;
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Begin a login: returns { location, bindingCookie }. */
export async function startOAuth(env, name, returnTo) {
  const p = getProvider(env, name);
  const state = randomToken(32);
  const binding = randomToken(32);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

  await env.DB.prepare(
    'INSERT INTO oauth_states (state_hash, binding_hash, provider, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      await hmac(env, 'oauth-state', state),
      await hmac(env, 'oauth-binding', binding),
      name,
      verifier,
      nonce,
      returnTo,
      Date.now() + 10 * 60 * 1000,
    )
    .run();

  const params = new URLSearchParams({
    client_id: p.clientId(env),
    redirect_uri: redirectUri(env, name),
    response_type: 'code',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (name === 'google') {
    params.set('scope', 'openid email');
    params.set('prompt', 'select_account');
  } else {
    // Apple only returns the email when it POSTs back to us (form_post).
    params.set('scope', 'email');
    params.set('response_mode', 'form_post');
  }
  // Apple's form_post is a cross-site POST, so its binding cookie must be SameSite=None.
  const sameSite = name === 'apple' ? 'None' : 'Lax';
  const bindingCookie = `${BINDING_COOKIE}=${binding}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=600`;
  return { location: `${p.authUrl}?${params}`, bindingCookie };
}

/** Finish a login. Returns { email, returnTo }. Throws HttpError on anything suspicious. */
export async function finishOAuth(env, name, { code, state, binding }) {
  const p = getProvider(env, name);
  if (!code || !state || !binding || typeof code !== 'string' || typeof state !== 'string') {
    throw new HttpError(400, 'Sign-in was cancelled or the link expired. Please try again.');
  }
  // Single-use: delete and read in one statement.
  const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *')
    .bind(await hmac(env, 'oauth-state', state))
    .first();
  if (!row || row.provider !== name || row.expires_at < Date.now()) {
    throw new HttpError(400, 'Sign-in expired. Please try again.');
  }
  if (row.binding_hash !== (await hmac(env, 'oauth-binding', binding))) {
    throw new HttpError(400, 'Sign-in must be finished in the same browser it was started in.');
  }

  const clientSecret = name === 'apple' ? await appleClientSecret(env) : env.GOOGLE_CLIENT_SECRET;
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, name),
      client_id: p.clientId(env),
      client_secret: clientSecret,
      code_verifier: row.verifier,
    }),
  });
  if (!res.ok) throw new HttpError(400, 'Could not complete sign-in with the provider. Please try again.');
  const tokens = await res.json();
  if (typeof tokens.id_token !== 'string') throw new HttpError(400, 'Provider did not return an identity.');

  const parts = tokens.id_token.split('.');
  if (parts.length !== 3) throw new HttpError(400, 'Malformed identity token.');
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new HttpError(400, 'Malformed identity token.');
  }
  const now = Math.floor(Date.now() / 1000);
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(p.clientId(env)) : claims.aud === p.clientId(env);
  if (!p.issuers.includes(claims.iss) || !audOk || !(claims.exp > now) || claims.nonce !== row.nonce) {
    throw new HttpError(400, 'Identity token failed verification.');
  }
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.email || !verified) {
    throw new HttpError(400, "Your account has no verified email address, so we can't recognise you. Please try the other sign-in option.");
  }
  return { email: claims.email, returnTo: row.return_to };
}

/** Apple's client_secret is a short-lived ES256 JWT signed with your .p8 key. */
async function appleClientSecret(env) {
  const pem = env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg: 'ES256', kid: env.APPLE_KEY_ID })}.${enc({
    iss: env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 300,
    aud: 'https://appleid.apple.com',
    sub: env.APPLE_CLIENT_ID,
  })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}
