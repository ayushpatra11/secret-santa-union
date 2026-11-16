// Shared test harness: a real local D1 database (via wrangler's platform proxy),
// the real request handler, and an email outbox captured from the console provider.

import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { handle } from '../src/api.js';

export const ORIGIN = 'http://localhost:8788';

export function setup() {
  const t = { env: null, emails: [], pending: [] };
  const ctx = { waitUntil: (p) => t.pending.push(p) };
  const realLog = console.log;
  let proxy;
  let persistDir;
  let ipCounter = 0;

  before(async () => {
    persistDir = mkdtempSync(join(tmpdir(), 'ss-test-'));
    proxy = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: persistDir } });
    const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const stmt of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await proxy.env.DB.prepare(stmt).run();
    }
    t.env = {
      DB: proxy.env.DB,
      APP_SECRET: 'test-secret-that-is-definitely-long-enough-0123456789',
      APP_URL: ORIGIN,
      EMAIL_PROVIDER: 'console',
    };
    console.log = (...args) => {
      const msg = args.join(' ');
      if (msg.startsWith('[email:console]')) t.emails.push(msg);
      else realLog(...args);
    };
  });

  after(async () => {
    console.log = realLog;
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

  t.codeFor = (fromIndex) =>
    t.emails
      .slice(fromIndex)
      .find((m) => m.includes('login code'))
      .match(/code is (\d{6})/)[1];

  t.login = async (email, name) => {
    const before = t.emails.length;
    const r1 = await t.call('POST', '/auth/request-otp', { body: { email } });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    const r2 = await t.call('POST', '/auth/verify-otp', { body: { email, code: t.codeFor(before) } });
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    const cookie = r2.headers.get('set-cookie').split(';')[0];
    if (name) assert.equal((await t.call('PATCH', '/me', { cookie, body: { name } })).status, 200);
    return { cookie, needsName: r2.data.needsName };
  };

  /** Parse captured match emails into { giverName: { giftee, key, exchangeId } }. */
  t.matchEmails = (fromIndex = 0) => {
    const out = [];
    for (const m of t.emails.slice(fromIndex)) {
      if (!m.includes('Open it in the app:')) continue;
      const [, exchangeId, key] = m.match(/#\/reveal\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})/);
      out.push({ giver: m.match(/Dear (.+),/)[1], giftee: m.match(/Secret Santa for: (.+)/)[1].trim(), key, exchangeId });
    }
    return out;
  };

  return t;
}
