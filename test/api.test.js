import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt } from '../src/crypto.js';
import { decodeKey, openSealedMatch } from '../public/lib/sealed.js';
import { setup } from './helpers.js';

const t = setup();
const call = (...a) => t.call(...a);
const flush = () => t.flush();
const login = (...a) => t.login(...a);
const emails = t.emails;
const envProxy = new Proxy({}, { get: (_, k) => t.env[k] });
const env = envProxy;

describe('security basics', () => {
  test('rejects cross-site and header-less mutations', async () => {
    const r1 = await call('POST', '/auth/request-otp', { body: { email: 'a@example.com' }, headers: { origin: 'https://evil.example' } });
    assert.equal(r1.status, 403);
    const r2 = await call('POST', '/auth/request-otp', { body: { email: 'a@example.com' }, headers: { 'x-requested-with': '' } });
    assert.equal(r2.status, 403);
  });

  test('requires login for private endpoints', async () => {
    assert.equal((await call('GET', '/exchanges')).status, 401);
    assert.equal((await call('GET', '/me')).data.user, null);
  });

  test('login cookie is HttpOnly, Secure, SameSite=Strict and __Host- prefixed', async () => {
    const before = emails.length;
    await call('POST', '/auth/request-otp', { body: { email: 'cookie@example.com' } });
    const code = emails.slice(before)[0].match(/code is (\d{6})/)[1];
    const r = await call('POST', '/auth/verify-otp', { body: { email: 'cookie@example.com', code } });
    const c = r.headers.get('set-cookie');
    assert.match(c, /^__Host-ss_session=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag);
  });

  test('wrong OTP fails, OTPs are single use, and attempts are limited', async () => {
    const email = 'otp@example.com';
    const before = emails.length;
    await call('POST', '/auth/request-otp', { body: { email } });
    const code = emails.slice(before)[0].match(/code is (\d{6})/)[1];
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await call('POST', '/auth/verify-otp', { body: { email, code: wrong } })).status, 400);
    assert.equal((await call('POST', '/auth/verify-otp', { body: { email, code } })).status, 200);
    assert.equal((await call('POST', '/auth/verify-otp', { body: { email, code } })).status, 400, 'reused code must fail');

    const b2 = emails.length;
    await call('POST', '/auth/request-otp', { body: { email } });
    const code2 = emails.slice(b2)[0].match(/code is (\d{6})/)[1];
    const bad = code2 === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) await call('POST', '/auth/verify-otp', { body: { email, code: bad } });
    const locked = await call('POST', '/auth/verify-otp', { body: { email, code: code2 } });
    assert.equal(locked.status, 429, 'correct code after too many failures must be refused');
  });

  test('rate limits code requests per email', async () => {
    const email = 'spam@example.com';
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/auth/request-otp', { body: { email } })).status, 200);
    assert.equal((await call('POST', '/auth/request-otp', { body: { email } })).status, 429);
  });

  test('stores no plaintext email addresses', async () => {
    await login('plaintext-check@example.com');
    const { results } = await env.DB.prepare('SELECT * FROM users').all();
    assert.ok(results.length > 0);
    for (const row of results) assert.ok(!JSON.stringify(row).includes('@'), 'email leaked into users table');
    const { results: otps } = await env.DB.prepare('SELECT * FROM otps').all();
    for (const row of otps) assert.ok(!JSON.stringify(row).includes('@'));
  });
});

describe('a full Secret Santa', () => {
  const people = {};
  let exId;
  let invite;

  test('everyone signs in and names themselves', async () => {
    for (const who of ['ayush', 'bea', 'cal', 'dev', 'eve']) {
      people[who] = await login(`${who}@example.com`);
      assert.equal(people[who].needsName, true);
      const r = await call('PATCH', '/me', { cookie: people[who].cookie, body: { name: who.toUpperCase() } });
      assert.equal(r.status, 200);
    }
  });

  test('organiser creates a session and takes part', async () => {
    const r = await call('POST', '/exchanges', {
      cookie: people.ayush.cookie,
      body: {
        name: 'Flat 4 <script>',
        budget: '£25',
        eventDate: '2026-12-20',
        message: 'Jumpers!',
        names: ['Ayush', 'Bea', 'Cal', 'Dev'],
        selfIndex: 0,
        wishlist: 'Socks',
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    exId = r.data.id;
    const g = await call('GET', `/exchanges/${exId}`, { cookie: people.ayush.cookie });
    assert.equal(g.data.exchange.budget, '£25');
    assert.equal(g.data.exchange.name, 'Flat 4 <script>', 'stored verbatim; escaped at render time');
    invite = g.data.exchange.inviteUrl.split('#/join/')[1];
    assert.match(invite, /^[A-Za-z0-9_-]{43}$/);
  });

  test('rejects duplicate names and too few people', async () => {
    const dup = await call('POST', '/exchanges', { cookie: people.bea.cookie, body: { name: 'x', names: ['A', 'a', 'B'] } });
    assert.equal(dup.status, 400);
    const few = await call('POST', '/exchanges', { cookie: people.bea.cookie, body: { name: 'x', names: ['A', 'B'] } });
    assert.equal(few.status, 400);
    // With 3 people your own match reveals every pair, so 3 is refused too.
    const three = await call('POST', '/exchanges', { cookie: people.bea.cookie, body: { name: 'x', names: ['A', 'B', 'C'] } });
    assert.equal(three.status, 400);
  });

  test('outsiders cannot see the session or its photo', async () => {
    assert.equal((await call('GET', `/exchanges/${exId}`, { cookie: people.eve.cookie })).status, 404);
    assert.equal((await call('GET', `/exchanges/${exId}/photo`, { cookie: people.eve.cookie })).status, 404);
  });

  test('only the organiser can upload a photo, and only real images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const notImg = new TextEncoder().encode('<svg onload=alert(1)>');
    const asBea = await call('PUT', `/exchanges/${exId}/photo`, {
      cookie: people.bea.cookie,
      rawBody: png,
      headers: { 'content-type': 'image/png' },
    });
    assert.equal(asBea.status, 403);
    const bad = await call('PUT', `/exchanges/${exId}/photo`, {
      cookie: people.ayush.cookie,
      rawBody: notImg,
      headers: { 'content-type': 'image/png' },
    });
    assert.equal(bad.status, 415);
    const ok = await call('PUT', `/exchanges/${exId}/photo`, {
      cookie: people.ayush.cookie,
      rawBody: png,
      headers: { 'content-type': 'image/png' },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const got = await call('GET', `/exchanges/${exId}/photo`, { cookie: people.ayush.cookie });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  });

  test('members join by picking a name; a name cannot be taken twice', async () => {
    const preview = await call('GET', `/invites/${invite}`, { cookie: people.bea.cookie });
    assert.equal(preview.status, 200);
    assert.ok(!JSON.stringify(preview.data).includes('@'), 'invite preview must not contain emails');
    const slots = preview.data.invite.slots;
    const bea = slots.find((s) => s.name === 'Bea');
    const cal = slots.find((s) => s.name === 'Cal');
    const ayushSlot = slots.find((s) => s.name === 'Ayush');

    assert.equal(
      (await call('POST', `/invites/${invite}/join`, { cookie: people.bea.cookie, body: { slotId: ayushSlot.id } })).status,
      409,
    );
    const j1 = await call('POST', `/invites/${invite}/join`, { cookie: people.bea.cookie, body: { slotId: bea.id, wishlist: 'Books' } });
    assert.equal(j1.status, 200);
    assert.equal(j1.data.drawn, false);
    assert.equal(
      (await call('POST', `/invites/${invite}/join`, { cookie: people.bea.cookie, body: { slotId: cal.id } })).status,
      409,
      'one person, one name',
    );

    const j2 = await call('POST', `/invites/${invite}/join`, {
      cookie: people.cal.cookie,
      body: { slotId: cal.id, wishlist: 'Hot sauce' },
    });
    assert.equal(j2.status, 200);
    assert.equal(j2.data.drawn, false);
    const dev = slots.find((s) => s.name === 'Dev');
    const j3 = await call('POST', `/invites/${invite}/join`, { cookie: people.dev.cookie, body: { slotId: dev.id } });
    assert.equal(j3.status, 200);
    assert.equal(j3.data.drawn, true, 'last join triggers the draw');
    await flush();
  });

  test('the session is locked after the draw', async () => {
    const r = await call('PATCH', `/exchanges/${exId}`, { cookie: people.ayush.cookie, body: { addNames: ['Eve'] } });
    assert.equal(r.status, 409);
    assert.equal((await call('POST', `/exchanges/${exId}/leave`, { cookie: people.bea.cookie })).status, 409);
    assert.equal((await call('PUT', `/exchanges/${exId}/wishlist`, { cookie: people.bea.cookie, body: { wishlist: 'x' } })).status, 409);
  });

  test('everyone is emailed a valid match, and only they can open it', async () => {
    const matchMails = emails.filter((m) => m.includes('Open it in the app:'));
    assert.equal(matchMails.length, 4);
    const byName = {};
    for (const m of matchMails) {
      const giver = m.match(/Dear (\w+),/)[1];
      const giftee = m.match(/Secret Santa for: (.+)/)[1].trim();
      const key = m.match(/#\/reveal\/[A-Za-z0-9_-]{22}\/([A-Za-z0-9_-]{43})/)[1];
      byName[giver] = { giftee, key };
    }
    const givers = Object.keys(byName).sort();
    assert.deepEqual(givers, ['Ayush', 'Bea', 'Cal', 'Dev']);
    assert.equal(new Set(Object.values(byName).map((x) => x.giftee)).size, 4);
    for (const g of givers) assert.notEqual(byName[g].giftee, g);

    // The member can open their sealed match in the app with the key from their email.
    const who = { Ayush: 'ayush', Bea: 'bea', Cal: 'cal', Dev: 'dev' };
    for (const g of givers) {
      const r = await call('GET', `/exchanges/${exId}/my-match`, { cookie: people[who[g]].cookie });
      assert.equal(r.status, 200);
      assert.ok(!JSON.stringify(r.data).includes(byName[g].giftee), 'API must not return a plaintext match');
      const match = await openSealedMatch(r.data.sealed, decodeKey(byName[g].key), r.data.slotId);
      assert.equal(match.name, byName[g].giftee);
    }
    // Someone else's key does not open your match.
    const ayushSealed = (await call('GET', `/exchanges/${exId}/my-match`, { cookie: people.ayush.cookie })).data;
    await assert.rejects(openSealedMatch(ayushSealed.sealed, decodeKey(byName.Bea.key), ayushSealed.slotId));
  });

  test('the operator cannot recover pairings from the database + APP_SECRET', async () => {
    const { results } = await env.DB.prepare('SELECT id, giftee_enc FROM slots WHERE exchange_id = ?').bind(exId).all();
    for (const row of results) {
      assert.ok(row.giftee_enc);
      for (const aad of [`match:${row.id}`, `giftee:${row.id}`, row.id]) {
        await assert.rejects(decrypt(env, row.giftee_enc, aad));
      }
    }
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM slots').all()).results);
    assert.ok(!/Books|Hot sauce|Socks/.test(dump), 'wishlists must be encrypted');
  });

  test('the organiser sees delivery status but no pairs', async () => {
    const r = await call('GET', `/exchanges/${exId}`, { cookie: people.ayush.cookie });
    assert.equal(r.data.exchange.status, 'drawn');
    assert.equal(r.data.exchange.inviteUrl, null);
    for (const s of r.data.exchange.slots) {
      assert.equal(s.emailStatus, 'sent');
      assert.deepEqual(Object.keys(s).sort(), ['emailStatus', 'id', 'isMe', 'joined', 'name']);
    }
    const redraw = await call('POST', `/exchanges/${exId}/redraw`, { cookie: people.ayush.cookie });
    assert.equal(redraw.status, 409, 'no redraw when every email was delivered');
  });

  test('non-organisers cannot delete; organiser can', async () => {
    assert.equal((await call('DELETE', `/exchanges/${exId}`, { cookie: people.bea.cookie })).status, 403);
    assert.equal((await call('DELETE', `/exchanges/${exId}`, { cookie: people.ayush.cookie })).status, 200);
    assert.equal((await call('GET', `/exchanges/${exId}`, { cookie: people.bea.cookie })).status, 404);
  });
});

describe('organiser edits', () => {
  test('can add and remove names while open, and the draw fires when the list fills up', async () => {
    const org = await login('org@example.com');
    await call('PATCH', '/me', { cookie: org.cookie, body: { name: 'Org' } });
    const a = await login('m1@example.com');
    const b = await login('m2@example.com');
    const c = await login('m3@example.com');
    const created = await call('POST', '/exchanges', {
      cookie: org.cookie,
      body: { name: 'Edits', names: ['Org', 'M1', 'M2', 'M3', 'Ghost'], selfIndex: 0 },
    });
    const id = created.data.id;
    const ex = (await call('GET', `/exchanges/${id}`, { cookie: org.cookie })).data.exchange;
    const token = ex.inviteUrl.split('#/join/')[1];
    const slot = (n) => ex.slots.find((s) => s.name === n).id;
    await call('POST', `/invites/${token}/join`, { cookie: a.cookie, body: { slotId: slot('M1') } });
    await call('POST', `/invites/${token}/join`, { cookie: b.cookie, body: { slotId: slot('M2') } });
    await call('POST', `/invites/${token}/join`, { cookie: c.cookie, body: { slotId: slot('M3') } });

    const nonOrg = await call('PATCH', `/exchanges/${id}`, { cookie: a.cookie, body: { removeSlotIds: [slot('Ghost')] } });
    assert.equal(nonOrg.status, 403);

    // Regenerating the invite kills the old link.
    const regen = await call('POST', `/exchanges/${id}/invite`, { cookie: org.cookie });
    assert.notEqual(regen.data.inviteUrl.split('#/join/')[1], token);
    assert.equal((await call('GET', `/invites/${token}`, { cookie: a.cookie })).status, 404);

    const r = await call('PATCH', `/exchanges/${id}`, { cookie: org.cookie, body: { removeSlotIds: [slot('Ghost')], budget: '$30' } });
    assert.equal(r.status, 200);
    await flush();
    const after = (await call('GET', `/exchanges/${id}`, { cookie: org.cookie })).data.exchange;
    assert.equal(after.status, 'drawn');
    assert.equal(after.budget, '$30');
  });
});

describe('account deletion', () => {
  test('removes the user and their sessions', async () => {
    const u = await login('bye@example.com');
    await call('PATCH', '/me', { cookie: u.cookie, body: { name: 'Bye' } });
    await call('POST', '/exchanges', { cookie: u.cookie, body: { name: 'Temp', names: ['A', 'B', 'C', 'D'] } });
    assert.equal((await call('DELETE', '/me', { cookie: u.cookie, body: { confirm: 'nope' } })).status, 400);
    assert.equal((await call('DELETE', '/me', { cookie: u.cookie, body: { confirm: 'DELETE' } })).status, 200);
    assert.equal((await call('GET', '/me', { cookie: u.cookie })).data.user, null);
  });
});
