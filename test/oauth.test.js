// Google / Apple sign-in, attacked from every angle. These run the real OAuth code;
// only the providers' token endpoints are simulated (see test/helpers.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './helpers.js';

const t = setup();
const failed = (r) => !r.cookie && r.location.includes('#/login?error=');

describe('sign-in happy paths', () => {
  test('Google: new users are sent to the welcome page, returning users home', async () => {
    const first = await t.oauth('g@example.com');
    assert.ok(first.cookie);
    assert.match(first.location, /\/#\/welcome$/);
    await t.call('PATCH', '/me', { cookie: first.cookie, body: { name: 'G' } });
    const again = await t.oauth('g@example.com');
    assert.match(again.location, /\/#\/home$/);
  });

  test('Apple: works through its cross-site form POST', async () => {
    const r = await t.oauth('a@privaterelay.appleid.com', { provider: 'apple' });
    assert.ok(r.cookie);
    // Apple's response_mode=form_post needs the binding cookie to survive a cross-site POST.
    assert.match(r.binding, /SameSite=None/);
    assert.match(r.binding, /Secure/);
  });

  test('uses PKCE (S256), a nonce and a state on every attempt', async () => {
    const r = await t.oauth('pkce@example.com');
    const q = r.auth.searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('state').length >= 43 && q.get('nonce').length >= 32);
    const sent = t.provider.requests.at(-1);
    assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), q.get('code_challenge'));
    assert.equal(sent.redirect_uri, 'http://localhost:8788/api/auth/oauth/google/callback');
  });

  test("Apple's client secret is a short-lived ES256 JWT for our team and client", async () => {
    await t.oauth('jwt@example.com', { provider: 'apple' });
    const [h, p, sig] = t.provider.requests.at(-1).client_secret.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    assert.deepEqual(header, { alg: 'ES256', kid: t.env.APPLE_KEY_ID });
    assert.equal(payload.iss, t.env.APPLE_TEAM_ID);
    assert.equal(payload.sub, t.env.APPLE_CLIENT_ID);
    assert.equal(payload.aud, 'https://appleid.apple.com');
    assert.ok(payload.exp - payload.iat <= 300);
    assert.equal(Buffer.from(sig, 'base64url').length, 64);
  });
});

describe('sign-in attacks', () => {
  test('a callback cannot be replayed', async () => {
    const r = await t.oauth('replay@example.com');
    assert.ok(r.cookie);
    const again = await t.call('GET', `/auth/oauth/google/callback?code=${r.cb.code}&state=${r.cb.state}`, {
      cookie: r.cb.cookie,
      headers: { origin: '', 'x-requested-with': '' },
    });
    assert.ok(again.headers.get('location').includes('#/login?error='));
    assert.ok(!again.headers.getSetCookie().some((c) => c.startsWith('__Host-ss_session=') && !c.includes('Max-Age=0')));
  });

  test("a login can't be finished in a different browser (login CSRF / session fixation)", async () => {
    const victimStart = await t.oauth('attacker@example.com', { alterCallback: (cb) => ({ ...cb, cookie: '' }) });
    assert.ok(failed(victimStart), 'no binding cookie');
    const other = await t.call('GET', '/auth/oauth/google/start', { headers: { origin: '', 'x-requested-with': '' } });
    const otherCookie = other.headers.getSetCookie()[0].split(';')[0];
    assert.ok(failed(await t.oauth('attacker@example.com', { alterCallback: (cb) => ({ ...cb, cookie: otherCookie }) })), 'wrong binding');
  });

  test('forged state is rejected', async () => {
    assert.ok(failed(await t.oauth('state@example.com', { alterCallback: (cb) => ({ ...cb, state: 'x'.repeat(43) }) })));
  });

  test('a state from one provider cannot be used with another', async () => {
    const start = await t.call('GET', '/auth/oauth/apple/start', { headers: { origin: '', 'x-requested-with': '' } });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const r = await t.call('GET', `/auth/oauth/google/callback?code=abc&state=${state}`, {
      cookie,
      headers: { origin: '', 'x-requested-with': '' },
    });
    assert.ok(r.headers.get('location').includes('#/login?error='));
  });

  const bad = {
    'wrong nonce (token injection)': (c) => ({ ...c, nonce: 'evil' }),
    'wrong audience (token for another app)': (c) => ({ ...c, aud: 'someone-elses-client' }),
    'wrong issuer': (c) => ({ ...c, iss: 'https://evil.example' }),
    'expired token': (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 10 }),
    'unverified email': (c) => ({ ...c, email_verified: false }),
    'no email': (c) => ({ ...c, email: undefined }),
    'garbage email': (c) => ({ ...c, email: 'not an email' }),
    'provider error': () => new Response('{"error":"server_error"}', { status: 500 }),
  };
  for (const [name, tamper] of Object.entries(bad)) {
    test(`rejects: ${name}`, async () => {
      t.provider.tamper = tamper;
      try {
        assert.ok(failed(await t.oauth(`tamper-${name.length}@example.com`)));
      } finally {
        t.provider.tamper = null;
      }
    });
  }

  test('Apple sends email_verified as the string "true"; anything else is refused', async () => {
    t.provider.tamper = (c) => ({ ...c, email_verified: 'true' });
    try {
      assert.ok((await t.oauth('string-true@example.com', { provider: 'apple' })).cookie);
      t.provider.tamper = (c) => ({ ...c, email_verified: 'false' });
      assert.ok(failed(await t.oauth('string-false@example.com', { provider: 'apple' })));
    } finally {
      t.provider.tamper = null;
    }
  });

  test('the return address only accepts invite links (no open redirect)', async () => {
    for (const evil of ['https://evil.example', '//evil.example', '#/join/../../x', 'javascript:alert(1)']) {
      const r = await t.oauth(`redirect-${evil.length}@example.com`, { returnTo: evil });
      assert.ok(r.location.startsWith('http://localhost:8788/#/'), r.location);
      assert.ok(!r.location.includes('evil') && !r.location.includes('javascript'), r.location);
    }
    const ok = `#/join/${'A'.repeat(43)}`;
    const r = await t.oauth('redirect-ok@example.com', { returnTo: ok });
    assert.ok(decodeURIComponent(r.location).includes(ok));
  });

  test('error messages are fixed text, never echoed from the request', async () => {
    const r = await t.call('GET', '/auth/oauth/google/callback?error=<script>alert(1)</script>', {
      headers: { origin: '', 'x-requested-with': '' },
    });
    assert.ok(!decodeURIComponent(r.headers.get('location')).includes('<script>'));
  });

  test('unconfigured providers are refused', async () => {
    const saved = t.env.APPLE_CLIENT_ID;
    delete t.env.APPLE_CLIENT_ID;
    try {
      const r = await t.call('GET', '/auth/oauth/apple/start', {
        headers: { origin: '', 'x-requested-with': '' },
      });
      assert.equal(r.status, 404);
      assert.deepEqual((await t.call('GET', '/config')).data.providers, ['google']);
    } finally {
      t.env.APPLE_CLIENT_ID = saved;
    }
  });

  test('the fake local Google can never be enabled outside localhost', async () => {
    const saved = { ...t.env };
    Object.assign(t.env, { DEV_OAUTH_BASE: 'http://localhost:8799', APP_URL: 'https://philipwantedagift.com' });
    try {
      const r = await t.call('GET', '/auth/oauth/google/start', { headers: { origin: '', 'x-requested-with': '' } });
      assert.equal(r.status, 500);
      Object.assign(t.env, { DEV_OAUTH_BASE: 'https://evil.example', APP_URL: 'http://localhost:8788' });
      assert.equal((await t.call('GET', '/auth/oauth/google/start', { headers: { origin: '', 'x-requested-with': '' } })).status, 500);
    } finally {
      for (const k of Object.keys(t.env)) delete t.env[k];
      Object.assign(t.env, saved);
    }
  });
});
