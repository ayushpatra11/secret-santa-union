// "Is there ANY way to find out who drew whom?" - adversarial + idempotency tests.
// Every test here plays a curious member, a nosy organiser, or a racing client.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openSealedMatch, unwrapMatchKey } from '../public/lib/sealed.js';
import { setup } from './helpers.js';

const t = setup();

/** Create a session with the given people, have everybody join, return handles. */
async function fullSession(tag, names, { organiserJoins = true, join = true } = {}) {
  const users = {};
  for (const n of names) users[n] = await t.login(`${tag}-${n.toLowerCase()}@example.com`, n);
  const orgName = names[0];
  const org = organiserJoins ? users[orgName] : await t.login(`${tag}-organiser@example.com`, 'Organiser');
  const created = await t.call('POST', '/exchanges', {
    cookie: org.cookie,
    body: { name: `${tag} party`, names, selfIndex: organiserJoins ? 0 : null },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const ex = (await t.call('GET', `/exchanges/${id}`, { cookie: org.cookie })).data.exchange;
  const token = ex.inviteUrl.split('#/join/')[1];
  const slotOf = Object.fromEntries(ex.slots.map((s) => [s.name, s.id]));
  if (join) {
    for (const n of names.slice(organiserJoins ? 1 : 0)) {
      const r = await t.call('POST', `/invites/${token}/join`, { cookie: users[n].cookie, body: { slotId: slotOf[n] } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    await t.flush();
  }
  return { id, token, org, users, slotOf };
}

/** Deep-scan any JSON for a forbidden key or for another person's match. */
function assertNoLeak(data, { forbiddenStrings = [] } = {}) {
  const text = JSON.stringify(data);
  for (const key of ['giftee', 'match', 'receiver', 'recipient', 'pairs', 'email_enc', 'giftee_enc', 'user_id', 'key']) {
    assert.ok(!new RegExp(`"${key}"`, 'i').test(text), `response leaks field "${key}": ${text.slice(0, 300)}`);
  }
  for (const s of forbiddenStrings) assert.ok(!text.includes(s), `response leaks "${s}"`);
  assert.ok(!/@example\.com/.test(text), 'response leaks an email address');
}

describe('signup', () => {
  test('first login creates a profile and asks for a name; later logins do not', async () => {
    const first = await t.login('newbie@example.com');
    assert.equal(first.needsName, true);
    await t.call('PATCH', '/me', { cookie: first.cookie, body: { name: 'Newbie' } });
    const second = await t.login('newbie@example.com');
    assert.equal(second.needsName, false);
    const me = await t.call('GET', '/me', { cookie: second.cookie });
    assert.equal(me.data.user.name, 'Newbie');
    assert.equal(me.data.user.email, undefined, 'the app does not know your email address');
  });

  test('email case and whitespace do not create duplicate accounts', async () => {
    const a = await t.login('Mixed.Case@Example.com', 'Mixed');
    const b = await t.login('  mixed.case@example.COM ');
    assert.equal(b.needsName, false);
    assert.equal((await t.call('GET', '/me', { cookie: b.cookie })).data.user.name, 'Mixed');
    assert.ok(a.cookie !== b.cookie, 'each login gets a fresh session token');
  });

  test('Google and Apple logins with the same email share one account', async () => {
    const g = await t.login('both@example.com', 'Both');
    const a = await t.login('BOTH@example.com', undefined, { provider: 'apple' });
    assert.equal(a.needsName, false);
    assert.equal(
      (await t.call('GET', '/me', { cookie: a.cookie })).data.user.id,
      (await t.call('GET', '/me', { cookie: g.cookie })).data.user.id,
    );
  });

  test('validates names', async () => {
    const u = await t.login('valid@example.com');
    assert.equal((await t.call('PATCH', '/me', { cookie: u.cookie, body: { name: '' } })).status, 400);
    assert.equal((await t.call('PATCH', '/me', { cookie: u.cookie, body: { name: 'x'.repeat(41) } })).status, 400);
  });

  test('logout ends the session; logout-all ends every session', async () => {
    const a = await t.login('multi@example.com', 'Multi');
    const b = await t.login('multi@example.com');
    await t.call('POST', '/auth/logout', { cookie: a.cookie });
    assert.equal((await t.call('GET', '/me', { cookie: a.cookie })).data.user, null);
    assert.ok((await t.call('GET', '/me', { cookie: b.cookie })).data.user);
    const c = await t.login('multi@example.com');
    await t.call('POST', '/auth/logout-all', { cookie: c.cookie });
    assert.equal((await t.call('GET', '/me', { cookie: b.cookie })).data.user, null);
  });

  test('forged or malformed session cookies are ignored', async () => {
    for (const cookie of ['__Host-ss_session=abc', `__Host-ss_session=${'A'.repeat(43)}`, '__Host-ss_session=../../etc']) {
      assert.equal((await t.call('GET', '/me', { cookie })).data.user, null);
    }
  });
});

describe('idempotency and races', () => {
  test('two people racing for the last spot: exactly one wins, exactly one draw', async () => {
    const s = await fullSession('race', ['Ann', 'Ben', 'Cat', 'Dot'], { join: false });
    await t.call('POST', `/invites/${s.token}/join`, { cookie: s.users.Ben.cookie, body: { slotId: s.slotOf.Ben } });
    await t.call('POST', `/invites/${s.token}/join`, { cookie: s.users.Dot.cookie, body: { slotId: s.slotOf.Dot } });
    const intruder = await t.login('race-intruder@example.com', 'Intruder');
    const results = await Promise.all([
      t.call('POST', `/invites/${s.token}/join`, { cookie: s.users.Cat.cookie, body: { slotId: s.slotOf.Cat } }),
      t.call('POST', `/invites/${s.token}/join`, { cookie: intruder.cookie, body: { slotId: s.slotOf.Cat } }),
    ]);
    await t.flush();
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.filter((r) => r.data.drawn).length, 1);
    const matches = await t.allMatches(s.id, s.users);
    assert.equal(new Set(Object.values(matches)).size, 4, 'exactly one valid draw');
  });

  test('the same person double-clicking join cannot claim two names', async () => {
    const s = await fullSession('dbl', ['Dee', 'Eli', 'Fay', 'Gus'], { join: false });
    const r = await Promise.all([
      t.call('POST', `/invites/${s.token}/join`, { cookie: s.users.Eli.cookie, body: { slotId: s.slotOf.Eli } }),
      t.call('POST', `/invites/${s.token}/join`, { cookie: s.users.Eli.cookie, body: { slotId: s.slotOf.Fay } }),
    ]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
    const ex = (await t.call('GET', `/exchanges/${s.id}`, { cookie: s.org.cookie })).data.exchange;
    assert.equal(ex.slots.filter((x) => x.joined).length, 2, 'organiser + Eli only');
  });

  test('a session is drawn once: repeating requests never re-draw or change anything', async () => {
    const s = await fullSession('once', ['Hal', 'Ivy', 'Jo', 'Kit']);
    const first = await t.allMatches(s.id, s.users);
    const sealedBefore = (await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.users.Ivy.cookie })).data;
    const attempts = await Promise.all([
      t.call('PATCH', `/exchanges/${s.id}`, { cookie: s.org.cookie, body: {} }),
      t.call('PATCH', `/exchanges/${s.id}`, { cookie: s.org.cookie, body: { addNames: ['Kai'] } }),
      t.call('POST', `/invites/${s.token}/join`, { cookie: s.users.Ivy.cookie, body: { slotId: s.slotOf.Ivy } }),
      t.call('POST', `/exchanges/${s.id}/leave`, { cookie: s.users.Jo.cookie }),
    ]);
    await t.flush();
    for (const a of attempts) assert.ok(a.status === 409 || a.status === 404, `expected refusal, got ${a.status}`);
    assert.deepEqual(await t.allMatches(s.id, s.users), first, 'matches unchanged');
    assert.deepEqual((await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.users.Ivy.cookie })).data, sealedBefore);
  });

  test('fetching your sealed match repeatedly returns the exact same bytes', async () => {
    const s = await fullSession('stable', ['Lu', 'Mo', 'Ned', 'Ola']);
    const a = await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.users.Mo.cookie });
    const b = await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.users.Mo.cookie });
    assert.equal(a.status, 200);
    assert.deepEqual(a.data, b.data);
  });

  test('many concurrent creates/joins keep every invariant', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `P${i}`);
    const s = await fullSession('bulk', names, { join: false });
    const r = await Promise.all(
      names.slice(1).map((n) => t.call('POST', `/invites/${s.token}/join`, { cookie: s.users[n].cookie, body: { slotId: s.slotOf[n] } })),
    );
    await t.flush();
    assert.ok(r.every((x) => x.status === 200));
    assert.equal(r.filter((x) => x.data.drawn).length, 1);
    const matches = await t.allMatches(s.id, s.users);
    assert.equal(Object.keys(matches).length, 12);
    assert.equal(new Set(Object.values(matches)).size, 12, 'everyone receives exactly once');
    for (const [giver, giftee] of Object.entries(matches)) assert.notEqual(giver, giftee);
  });
});

describe('no peeking', () => {
  test('no API response, for anyone, ever contains a pairing', async () => {
    const s = await fullSession('peek', ['Oli', 'Pam', 'Quin', 'Rae']);
    for (const u of Object.values(s.users)) {
      const view = await t.call('GET', `/exchanges/${s.id}`, { cookie: u.cookie });
      assertNoLeak(view.data);
      const list = await t.call('GET', '/exchanges', { cookie: u.cookie });
      assertNoLeak(list.data);
      // The sealed blob is opaque: it must not contain the giftee's name.
      const mine = await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: u.cookie });
      const myGiftee = (await t.reveal(s.id, u)).name;
      // (Decode first: a short name can appear by chance inside base64 text.)
      for (const blob of [mine.data.sealed, ...mine.data.wraps.map((w) => w.wrapped)]) {
        assert.ok(!atob(blob).includes(myGiftee), 'plaintext giftee name inside the ciphertext');
      }
      assert.deepEqual(Object.keys(mine.data).sort(), ['sealed', 'slotId', 'wraps']);
    }
  });

  test('a non-participating organiser cannot get any match', async () => {
    const s = await fullSession('org', ['Sam', 'Tia', 'Uma', 'Val'], { organiserJoins: false });
    const r = await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.org.cookie });
    assert.equal(r.status, 404);
    // Even after redrawing (which they're allowed to do), they still can't see anything.
    assert.equal((await t.call('POST', `/exchanges/${s.id}/redraw`, { cookie: s.org.cookie })).status, 200);
    assert.equal((await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.org.cookie })).status, 404);
    assertNoLeak((await t.call('GET', `/exchanges/${s.id}`, { cookie: s.org.cookie })).data);
  });

  test('members cannot redraw, delete, edit, or reopen', async () => {
    const s = await fullSession('mem', ['Vic', 'Wes', 'Xan', 'Yul']);
    const c = s.users.Wes.cookie;
    assert.equal((await t.call('POST', `/exchanges/${s.id}/redraw`, { cookie: c })).status, 403);
    assert.equal((await t.call('DELETE', `/exchanges/${s.id}`, { cookie: c })).status, 403);
    assert.equal((await t.call('PATCH', `/exchanges/${s.id}`, { cookie: c, body: { name: 'mine now' } })).status, 403);
    assert.equal((await t.call('POST', `/exchanges/${s.id}/invite`, { cookie: c })).status, 403);
  });

  test("you cannot open anyone else's match, even with the right session id", async () => {
    const s = await fullSession('keys', ['Yas', 'Zed', 'Abe', 'Bix']);
    const zed = (await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.users.Zed.cookie })).data;
    // No one else's device key can unwrap Zed's match key.
    for (const [name, u] of Object.entries(s.users)) {
      if (name === 'Zed') continue;
      await assert.rejects(
        unwrapMatchKey(u.device.privateKey, zed.wraps[0], zed.slotId, s.users.Zed.device.id),
        `${name} opened Zed's key`,
      );
    }
    // Swapping slot ids (AAD) also fails, so ciphertexts cannot be shuffled around.
    const yas = (await t.call('GET', `/exchanges/${s.id}/my-match`, { cookie: s.users.Yas.cookie })).data;
    const yasKey = await unwrapMatchKey(s.users.Yas.device.privateKey, yas.wraps[0], yas.slotId, s.users.Yas.device.id);
    await assert.rejects(openSealedMatch(zed.sealed, yasKey, zed.slotId), "Yas's key opened Zed's match");
    await assert.rejects(openSealedMatch(yas.sealed, yasKey, zed.slotId));
    assert.ok((await openSealedMatch(yas.sealed, yasKey, yas.slotId)).name);
  });

  test('outsiders get nothing: not the session, the match, the photo, or the invite', async () => {
    const s = await fullSession('out', ['Bo', 'Cy', 'Di', 'Em']);
    const outsider = await t.login('outsider@example.com', 'Outsider');
    for (const path of [`/exchanges/${s.id}`, `/exchanges/${s.id}/my-match`, `/exchanges/${s.id}/photo`]) {
      assert.equal((await t.call('GET', path, { cookie: outsider.cookie })).status, 404, path);
    }
    const join = await t.call('POST', `/invites/${s.token}/join`, { cookie: outsider.cookie, body: { slotId: s.slotOf.Bo } });
    assert.equal(join.status, 409, 'cannot join a drawn session');
  });

  test("a slot id from another session can't be claimed through this invite", async () => {
    const a = await fullSession('xa', ['Ed', 'Flo', 'Gil', 'Hap'], { join: false });
    const b = await fullSession('xb', ['Hu', 'Ian', 'Jay', 'Kev'], { join: false });
    const r = await t.call('POST', `/invites/${a.token}/join`, { cookie: b.users.Ian.cookie, body: { slotId: b.slotOf.Ian } });
    assert.equal(r.status, 409);
  });

  test('invite tokens and ids cannot be guessed or injected', async () => {
    const u = await t.login('guesser@example.com', 'Guesser');
    for (const bad of ['x', "' OR 1=1 --", 'A'.repeat(43), '../../exchanges']) {
      const r = await t.call('GET', `/invites/${encodeURIComponent(bad)}`, { cookie: u.cookie });
      assert.equal(r.status, 404, bad);
    }
    assert.equal((await t.call('GET', `/exchanges/${encodeURIComponent("1' OR '1'='1")}`, { cookie: u.cookie })).status, 404);
  });

  test('database rows hold no readable pairings, wishlists, emails or tokens', async () => {
    const s = await fullSession('db', ['Kim', 'Lea', 'Max', 'Nia']);
    const tables = [
      'users',
      'slots',
      'exchanges',
      'auth_sessions',
      'rate_limits',
      'oauth_states',
      'exchange_photos',
      'device_keys',
      'match_key_wraps',
    ];
    let dump = '';
    for (const tb of tables) dump += JSON.stringify((await t.env.DB.prepare(`SELECT * FROM ${tb}`).all()).results);
    assert.ok(!dump.includes('@example.com'), 'plaintext email in DB');
    assert.ok(!dump.includes(s.token), 'plaintext invite token in DB');
    // The slots table must not link a giver row to a giftee name in clear text.
    const slots = (await t.env.DB.prepare('SELECT * FROM slots WHERE exchange_id = ?').bind(s.id).all()).results;
    for (const row of slots) {
      const others = slots.filter((o) => o.id !== row.id).map((o) => o.name);
      for (const n of others) assert.ok(!String(row.giftee_enc).includes(n));
    }
  });
});
