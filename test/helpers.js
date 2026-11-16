// Shared test harness: a real local D1 database (via wrangler's platform proxy) and the
// real request handler. Logins go through the real Google/Apple OAuth code; only the
// providers' token endpoints are faked (see t.provider below).

import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { handle } from '../src/api.js';
import { generateDeviceKey, openSealedMatch, unwrapMatchKey } from '../public/lib/sealed.js';

export const ORIGIN = 'http://localhost:8788';

export function setup() {
  const t = { env: null, pending: [] };
  const ctx = { waitUntil: (p) => t.pending.push(p) };
  const realFetch = globalThis.fetch;
  const codes = new Map();
  // What the fake token endpoint returns. Tests can override this to simulate a
  // malicious or broken provider: (claims, request) => claims | Response.
  t.provider = { tamper: null, requests: [] };
  let proxy;
  let persistDir;
  let ipCounter = 0;

  before(async () => {
    persistDir = mkdtempSync(join(tmpdir(), 'ss-test-'));
    proxy = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: persistDir } });
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(new URL(file, dir), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n');
      for (const stmt of sql
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean)) {
        await proxy.env.DB.prepare(stmt).run();
      }
    }
    const appleKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', appleKey.privateKey)).toString('base64');
    t.env = {
      DB: proxy.env.DB,
      APP_SECRET: randomBytes(32).toString('base64'), // fresh per run; never a fixed secret
      APP_URL: ORIGIN,
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: randomBytes(16).toString('hex'),
      APPLE_CLIENT_ID: 'com.example.santa',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
    };
    // Fake Google/Apple token endpoints. Everything else (state, PKCE, nonce, cookie
    // binding, claim checks, sessions) runs the real code.
    const issuers = {
      'https://oauth2.googleapis.com/token': 'https://accounts.google.com',
      'https://appleid.apple.com/auth/token': 'https://appleid.apple.com',
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url || input);
      if (!issuers[url]) return realFetch(input, init);
      const form = new URLSearchParams(String(init.body));
      t.provider.requests.push(Object.fromEntries(form));
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!entry || !form.get('code_verifier') || !form.get('client_secret'))
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      let claims = {
        iss: issuers[url],
        aud: form.get('client_id'),
        sub: entry.email,
        email: entry.email,
        email_verified: true,
        nonce: entry.nonce,
        iat: now,
        exp: now + 300,
      };
      if (t.provider.tamper) {
        claims = t.provider.tamper(claims, form);
        if (claims instanceof Response) return claims;
      }
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return Response.json({ id_token: `${b64({ alg: 'none' })}.${b64(claims)}.` });
    };
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await proxy?.dispose();
    rmSync(persistDir, { recursive: true, force: true });
  });

  t.call = async (method, path, { body, cookie, headers = {}, rawBody, ip } = {}) => {
    const h = new Headers({
      origin: ORIGIN,
      'x-requested-with': 'secret-santa',
      'cf-connecting-ip': ip || `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`,
      ...headers,
    });
    if (cookie) h.set('cookie', cookie);
    let payload;
    if (rawBody) payload = rawBody;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h.set('content-type', 'application/json');
    }
    const res = await handle(new Request(`${ORIGIN}/api${path}`, { method, headers: h, body: payload }), t.env, ctx);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };

  /** Wait for background work (emails sent via waitUntil). */
  t.flush = async () => {
    while (t.pending.length) await t.pending.shift();
  };

  /**
   * Run a real sign-in: /start (gets state + nonce + binding cookie), the user "approves"
   * at the provider, then the callback. Returns { status, location, cookie, binding, ... }.
   */
  t.oauth = async (email, { provider = 'google', returnTo, alterCallback } = {}) => {
    const qs = returnTo ? `?return=${encodeURIComponent(returnTo)}` : '';
    const start = await t.call('GET', `/auth/oauth/${provider}/start${qs}`, { headers: { origin: '', 'x-requested-with': '' } });
    assert.equal(start.status, 303, JSON.stringify(start.data));
    const auth = new URL(start.headers.get('location'));
    const binding = start.headers.getSetCookie().find((c) => c.startsWith('__Host-ss_oauth='));
    const code = randomBytes(16).toString('hex');
    codes.set(code, { email, nonce: auth.searchParams.get('nonce') });
    let cb = { code, state: auth.searchParams.get('state'), cookie: binding.split(';')[0] };
    if (alterCallback) cb = alterCallback(cb);
    const params = new URLSearchParams({ code: cb.code, state: cb.state });
    const res =
      provider === 'apple'
        ? await t.call('POST', `/auth/oauth/apple/callback`, {
            cookie: cb.cookie,
            rawBody: params.toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://appleid.apple.com', 'x-requested-with': '' },
          })
        : await t.call('GET', `/auth/oauth/google/callback?${params}`, {
            cookie: cb.cookie,
            headers: { origin: '', 'x-requested-with': '' },
          });
    const location = res.headers.get('location') || '';
    const session = res.headers.getSetCookie().find((c) => c.startsWith('__Host-ss_session=') && !c.includes('Max-Age=0'));
    return { status: res.status, location, sessionCookie: session, cookie: session?.split(';')[0], auth, binding, cb };
  };

  /** A browser's device key, registered for the given login. */
  t.addDevice = async (cookie) => {
    const key = await generateDeviceKey();
    const r = await t.call('POST', '/devices', { cookie, body: { publicKey: key.publicKey } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { ...key, id: r.data.deviceId };
  };

  /** Sign up / log in (via Google by default). Registers a device key unless { device: false }. */
  t.login = async (email, name, { device = true, provider = 'google' } = {}) => {
    const r = await t.oauth(email, { provider });
    assert.equal(r.status, 303);
    assert.ok(r.cookie, `login failed: ${decodeURIComponent(r.location)}`);
    const cookie = r.cookie;
    if (name) assert.equal((await t.call('PATCH', '/me', { cookie, body: { name } })).status, 200);
    return { cookie, needsName: r.location.includes('#/welcome'), device: device ? await t.addDevice(cookie) : null };
  };

  /** Open a member's match the way their browser does. Returns { name, wishlist } or null. */
  t.reveal = async (exchangeId, user, device = user.device) => {
    const r = await t.call('GET', `/exchanges/${exchangeId}/my-match`, { cookie: user.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const wrap = device && r.data.wraps.find((w) => w.deviceId === device.id);
    if (!wrap) return null;
    const key = await unwrapMatchKey(device.privateKey, wrap, r.data.slotId, device.id);
    return openSealedMatch(r.data.sealed, key, r.data.slotId);
  };

  /** { giverName: gifteeName } for every member (as only each member could see it). */
  t.allMatches = async (exchangeId, usersByName) => {
    const out = {};
    for (const [name, u] of Object.entries(usersByName)) out[name] = (await t.reveal(exchangeId, u)).name;
    return out;
  };

  return t;
}
