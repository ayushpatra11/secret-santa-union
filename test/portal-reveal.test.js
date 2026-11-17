// Matches are only visible in the app, unlocked by each member's own device keys.
// The server can lock a match to a device, but never unlock it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapMatchKey } from '../public/lib/sealed.js';
import { setup } from './helpers.js';

const t = setup();

async function drawnSession(tag, names) {
  const users = {};
  for (const n of names) users[n] = await t.login(`${tag}-${n.toLowerCase()}@example.com`, n);
  const created = await t.call('POST', '/exchanges', { cookie: users[names[0]].cookie, body: { name: tag, names, selfIndex: 0 } });
  const exId = created.data.id;
  const ex = (await t.call('GET', `/exchanges/${exId}`, { cookie: users[names[0]].cookie })).data.exchange;
  const token = ex.inviteUrl.split('#/join/')[1];
  return { exId, token, users, slots: ex.slots };
}

async function joinAll({ token, users, slots }, names) {
  for (const n of names) {
    const r = await t.call('POST', `/invites/${token}/join`, {
      cookie: users[n].cookie,
      body: { slotId: slots.find((s) => s.name === n).id },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}

describe('devices', () => {
  test('rejects junk device keys', async () => {
    const u = await t.login('junk@example.com', 'Junk');
    for (const publicKey of [undefined, 'abc', btoa('x'.repeat(65)), 'A'.repeat(500)]) {
      assert.equal((await t.call('POST', '/devices', { cookie: u.cookie, body: { publicKey } })).status, 400);
    }
    assert.equal((await t.call('POST', '/devices', { body: { publicKey: 'abc' } })).status, 401);
  });

  test("you can't join (or take part as organiser) without a device that could open your match", async () => {
    const org = await t.login('nodev-org@example.com', 'Org', { device: false });
    const asSelf = await t.call('POST', '/exchanges', {
      cookie: org.cookie,
      body: { name: 'x', names: ['Org', 'B', 'C', 'D'], selfIndex: 0 },
    });
    assert.equal(asSelf.status, 400);
    // Organising without taking part is fine.
    const created = await t.call('POST', '/exchanges', { cookie: org.cookie, body: { name: 'x', names: ['A', 'B', 'C', 'D'] } });
    assert.equal(created.status, 201);
    const ex = (await t.call('GET', `/exchanges/${created.data.id}`, { cookie: org.cookie })).data.exchange;
    const token = ex.inviteUrl.split('#/join/')[1];
    const noDevice = await t.login('nodev-member@example.com', 'NoDevice', { device: false });
    const r = await t.call('POST', `/invites/${token}/join`, { cookie: noDevice.cookie, body: { slotId: ex.slots[0].id } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /secret key/);
  });
});

describe('portal reveal', () => {
  test('every device registered before the draw can open the match; later ones cannot', async () => {
    const s = await drawnSession('multi', ['Ana', 'Bob', 'Cid', 'Dia']);
    const phone = await t.addDevice(s.users.Ana.cookie);
    await joinAll(s, ['Bob', 'Cid', 'Dia']);
    const laptop = await t.reveal(s.exId, s.users.Ana);
    assert.ok(laptop);
    assert.deepEqual(await t.reveal(s.exId, s.users.Ana, phone), laptop, 'second device sees the same match');
    const late = await t.addDevice(s.users.Ana.cookie);
    assert.equal(await t.reveal(s.exId, s.users.Ana, late), null, 'a device added after the draw gets nothing');
    const view = (await t.call('GET', `/exchanges/${s.exId}`, { cookie: s.users.Ana.cookie })).data.exchange;
    assert.ok(view.slots.every((x) => x.canUnlock));
  });

  test("keys are bound to their slot and device, and can't be opened by anyone else", async () => {
    const s = await drawnSession('bind', ['Eli', 'Fen', 'Gia', 'Hob']);
    await joinAll(s, ['Fen', 'Gia', 'Hob']);
    const fen = (await t.call('GET', `/exchanges/${s.exId}/my-match`, { cookie: s.users.Fen.cookie })).data;
    assert.deepEqual(
      fen.wraps.map((w) => w.deviceId),
      [s.users.Fen.device.id],
      'you only ever receive wraps for your own devices',
    );
    // Someone else's private key can't unwrap it, and the wrap can't be replayed elsewhere.
    await assert.rejects(unwrapMatchKey(s.users.Gia.device.privateKey, fen.wraps[0], fen.slotId, s.users.Fen.device.id));
    await assert.rejects(unwrapMatchKey(s.users.Fen.device.privateKey, fen.wraps[0], 'another-slot-id-xxxxxx', s.users.Fen.device.id));
    await assert.rejects(unwrapMatchKey(s.users.Fen.device.privateKey, fen.wraps[0], fen.slotId, 'another-device-id-xxxx'));
  });

  test('a redraw replaces every match and old keys stop working', async () => {
    const s = await drawnSession('redraw', ['Ike', 'Jas', 'Kai', 'Lux']);
    await joinAll(s, ['Jas', 'Kai', 'Lux']);
    const oldView = (await t.call('GET', `/exchanges/${s.exId}/my-match`, { cookie: s.users.Jas.cookie })).data;
    assert.equal(
      (await t.call('POST', `/exchanges/${s.exId}/redraw`, { cookie: s.users.Jas.cookie })).status,
      403,
      'members cannot redraw',
    );
    assert.equal((await t.call('POST', `/exchanges/${s.exId}/redraw`, { cookie: s.users.Ike.cookie })).status, 200);
    const newView = (await t.call('GET', `/exchanges/${s.exId}/my-match`, { cookie: s.users.Jas.cookie })).data;
    assert.notEqual(newView.sealed, oldView.sealed);
    assert.equal(newView.wraps.length, 1);
    const all = await t.allMatches(s.exId, s.users);
    assert.equal(new Set(Object.values(all)).size, 4);
    for (const [g, r] of Object.entries(all)) assert.notEqual(g, r);
    // The organiser's redraw is rate-limited, so it can't be used to "roll" repeatedly.
    for (let i = 0; i < 2; i++) await t.call('POST', `/exchanges/${s.exId}/redraw`, { cookie: s.users.Ike.cookie });
    assert.equal((await t.call('POST', `/exchanges/${s.exId}/redraw`, { cookie: s.users.Ike.cookie })).status, 429);
  });

  test('the database never holds anything that opens a match', async () => {
    const { results: devices } = await t.env.DB.prepare('SELECT * FROM device_keys').all();
    // Public keys are 65-byte uncompressed P-256 points: no private key material is ever sent.
    for (const d of devices) assert.equal(atob(d.public_key).length, 65);
    assert.ok((await t.env.DB.prepare('SELECT COUNT(*) AS n FROM match_key_wraps').first()).n > 0);
  });
});
