// End-to-end API tests: security basics, a full Secret Santa, organiser edits, deletion.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt } from '../src/crypto.js';
import { setup } from './helpers.js';

const t = setup();
const call = (...a) => t.call(...a);
const login = (...a) => t.login(...a);

describe('security basics', () => {
  test('rejects cross-site and header-less mutations', async () => {
    const u = await login('csrf@example.com', 'Csrf');
    const r1 = await call('PATCH', '/me', { cookie: u.cookie, body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    assert.equal(r1.status, 403);
    const r2 = await call('PATCH', '/me', { cookie: u.cookie, body: { name: 'x' }, headers: { 'x-requested-with': '' } });
    assert.equal(r2.status, 403);
  });

  test('requires login for private endpoints', async () => {
    assert.equal((await call('GET', '/exchanges')).status, 401);
    assert.equal((await call('GET', '/me')).data.user, null);
  });

  test('there is no email/password/code login at all', async () => {
    for (const path of ['/auth/request-otp', '/auth/verify-otp', '/auth/login', '/auth/register']) {
      assert.equal((await call('POST', path, { body: { email: 'x@example.com' } })).status, 404, path);
    }
  });

  test('session cookie is HttpOnly, Secure, SameSite=Strict and __Host- prefixed', async () => {
    const r = await t.oauth('cookie@example.com');
    assert.match(r.sessionCookie, /^__Host-ss_session=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(r.sessionCookie.includes(flag), flag);
  });

  test('email addresses are not stored anywhere, not even encrypted', async () => {
    await login('plaintext-check@example.com');
    const { results } = await t.env.DB.prepare('SELECT * FROM users').all();
    assert.ok(results.length > 0);
    for (const row of results) {
      assert.deepEqual(Object.keys(row).sort(), ['created_at', 'display_name', 'email_hash', 'id']);
      assert.ok(!JSON.stringify(row).includes('@'));
    }
  });
});

describe('a full Secret Santa', () => {
  const people = {};
  let exId;
  let invite;

  test('everyone signs in and names themselves', async () => {
    for (const who of ['Ayush', 'Bea', 'Cal', 'Dev', 'Eve']) {
      people[who] = await login(`${who.toLowerCase()}@example.com`);
      assert.equal(people[who].needsName, true);
      assert.equal((await call('PATCH', '/me', { cookie: people[who].cookie, body: { name: who } })).status, 200);
    }
  });

  test('organiser creates a session and takes part', async () => {
    const r = await call('POST', '/exchanges', {
      cookie: people.Ayush.cookie,
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
    const g = await call('GET', `/exchanges/${exId}`, { cookie: people.Ayush.cookie });
    assert.equal(g.data.exchange.budget, '£25');
    assert.equal(g.data.exchange.name, 'Flat 4 <script>', 'stored verbatim; escaped at render time');
    invite = g.data.exchange.inviteUrl.split('#/join/')[1];
    assert.match(invite, /^[A-Za-z0-9_-]{43}$/);
  });

  test('rejects duplicate names and fewer than 4 people', async () => {
    const make = (names) => call('POST', '/exchanges', { cookie: people.Bea.cookie, body: { name: 'x', names } });
    assert.equal((await make(['A', 'a', 'B', 'C'])).status, 400);
    assert.equal((await make(['A', 'B'])).status, 400);
    // With 3 people your own match reveals every pair, so 3 is refused too.
    assert.equal((await make(['A', 'B', 'C'])).status, 400);
  });

  test('outsiders cannot see the session or its photo', async () => {
    assert.equal((await call('GET', `/exchanges/${exId}`, { cookie: people.Eve.cookie })).status, 404);
    assert.equal((await call('GET', `/exchanges/${exId}/photo`, { cookie: people.Eve.cookie })).status, 404);
  });

  test('only the organiser can upload a photo, and only real images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const notImg = new TextEncoder().encode('<svg onload=alert(1)>');
    const put = (who, body) =>
      call('PUT', `/exchanges/${exId}/photo`, { cookie: people[who].cookie, rawBody: body, headers: { 'content-type': 'image/png' } });
    assert.equal((await put('Bea', png)).status, 403);
    assert.equal((await put('Ayush', notImg)).status, 415);
    assert.equal((await put('Ayush', png)).status, 200);
    const got = await call('GET', `/exchanges/${exId}/photo`, { cookie: people.Ayush.cookie });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  });

  test('members join by picking a name; a name cannot be taken twice', async () => {
    const preview = await call('GET', `/invites/${invite}`, { cookie: people.Bea.cookie });
    assert.equal(preview.status, 200);
    assert.ok(!JSON.stringify(preview.data).includes('@'), 'invite preview must not contain emails');
    const slot = (n) => preview.data.invite.slots.find((s) => s.name === n).id;
    const join = (who, slotId, wishlist) =>
      call('POST', `/invites/${invite}/join`, { cookie: people[who].cookie, body: { slotId, wishlist } });

    assert.equal((await join('Bea', slot('Ayush'))).status, 409);
    const j1 = await join('Bea', slot('Bea'), 'Books');
    assert.equal(j1.status, 200);
    assert.equal(j1.data.drawn, false);
    assert.equal((await join('Bea', slot('Cal'))).status, 409, 'one person, one name');
    assert.equal((await join('Cal', slot('Cal'), 'Hot sauce')).data.drawn, false);
    const last = await join('Dev', slot('Dev'));
    assert.equal(last.status, 200);
    assert.equal(last.data.drawn, true, 'last join triggers the draw');
  });

  test('the session is locked after the draw', async () => {
    assert.equal((await call('PATCH', `/exchanges/${exId}`, { cookie: people.Ayush.cookie, body: { addNames: ['Eve'] } })).status, 409);
    assert.equal((await call('POST', `/exchanges/${exId}/leave`, { cookie: people.Bea.cookie })).status, 409);
    assert.equal((await call('PUT', `/exchanges/${exId}/wishlist`, { cookie: people.Bea.cookie, body: { wishlist: 'x' } })).status, 409);
  });

  test('everyone sees a valid match in the app, with the wishlist', async () => {
    const members = { Ayush: people.Ayush, Bea: people.Bea, Cal: people.Cal, Dev: people.Dev };
    const matches = await t.allMatches(exId, members);
    assert.equal(new Set(Object.values(matches)).size, 4, 'everyone is drawn exactly once');
    for (const [giver, giftee] of Object.entries(matches)) assert.notEqual(giver, giftee);
    const beasSanta = Object.keys(matches).find((g) => matches[g] === 'Bea');
    assert.equal((await t.reveal(exId, people[beasSanta])).wishlist, 'Books');
  });

  test('the operator cannot recover pairings from the database + APP_SECRET', async () => {
    const { results } = await t.env.DB.prepare('SELECT id, giftee_enc FROM slots WHERE exchange_id = ?').bind(exId).all();
    for (const row of results) {
      assert.ok(row.giftee_enc);
      for (const aad of [`match:${row.id}`, `giftee:${row.id}`, row.id]) {
        await assert.rejects(decrypt(t.env, row.giftee_enc, aad));
      }
    }
    const dump = JSON.stringify((await t.env.DB.prepare('SELECT * FROM slots').all()).results);
    assert.ok(!/Books|Hot sauce|Socks/.test(dump), 'wishlists must be encrypted');
  });

  test('the organiser sees who can open their match, but no pairs', async () => {
    const r = await call('GET', `/exchanges/${exId}`, { cookie: people.Ayush.cookie });
    assert.equal(r.data.exchange.status, 'drawn');
    assert.equal(r.data.exchange.inviteUrl, null);
    for (const s of r.data.exchange.slots) {
      assert.equal(s.canUnlock, true);
      assert.deepEqual(Object.keys(s).sort(), ['canUnlock', 'id', 'isMe', 'joined', 'name']);
    }
  });

  test('non-organisers cannot delete; organiser can', async () => {
    assert.equal((await call('DELETE', `/exchanges/${exId}`, { cookie: people.Bea.cookie })).status, 403);
    assert.equal((await call('DELETE', `/exchanges/${exId}`, { cookie: people.Ayush.cookie })).status, 200);
    assert.equal((await call('GET', `/exchanges/${exId}`, { cookie: people.Bea.cookie })).status, 404);
  });
});

describe('organiser edits', () => {
  test('can add and remove names while open, and the draw fires when the list fills up', async () => {
    const org = await login('org@example.com', 'Org');
    const m = [await login('m1@example.com'), await login('m2@example.com'), await login('m3@example.com')];
    const created = await call('POST', '/exchanges', {
      cookie: org.cookie,
      body: { name: 'Edits', names: ['Org', 'M1', 'M2', 'M3', 'Ghost'], selfIndex: 0 },
    });
    const id = created.data.id;
    const ex = (await call('GET', `/exchanges/${id}`, { cookie: org.cookie })).data.exchange;
    const token = ex.inviteUrl.split('#/join/')[1];
    const slot = (n) => ex.slots.find((s) => s.name === n).id;
    for (const [i, u] of m.entries())
      await call('POST', `/invites/${token}/join`, { cookie: u.cookie, body: { slotId: slot(`M${i + 1}`) } });

    assert.equal((await call('PATCH', `/exchanges/${id}`, { cookie: m[0].cookie, body: { removeSlotIds: [slot('Ghost')] } })).status, 403);

    // Regenerating the invite kills the old link.
    const regen = await call('POST', `/exchanges/${id}/invite`, { cookie: org.cookie });
    assert.notEqual(regen.data.inviteUrl.split('#/join/')[1], token);
    assert.equal((await call('GET', `/invites/${token}`, { cookie: m[0].cookie })).status, 404);

    const r = await call('PATCH', `/exchanges/${id}`, { cookie: org.cookie, body: { removeSlotIds: [slot('Ghost')], budget: '$30' } });
    assert.equal(r.status, 200);
    const after = (await call('GET', `/exchanges/${id}`, { cookie: org.cookie })).data.exchange;
    assert.equal(after.status, 'drawn');
    assert.equal(after.budget, '$30');
  });
});

describe('account deletion', () => {
  test('removes the user, their devices and their sessions', async () => {
    const u = await login('bye@example.com', 'Bye');
    await call('POST', '/exchanges', { cookie: u.cookie, body: { name: 'Temp', names: ['A', 'B', 'C', 'D'] } });
    assert.equal((await call('DELETE', '/me', { cookie: u.cookie, body: { confirm: 'nope' } })).status, 400);
    assert.equal((await call('DELETE', '/me', { cookie: u.cookie, body: { confirm: 'DELETE' } })).status, 200);
    assert.equal((await call('GET', '/me', { cookie: u.cookie })).data.user, null);
    const left = await t.env.DB.prepare('SELECT COUNT(*) AS n FROM device_keys WHERE id = ?').bind(u.device.id).first();
    assert.equal(left.n, 0);
  });
});
