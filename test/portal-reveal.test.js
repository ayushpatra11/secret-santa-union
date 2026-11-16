// The portal reveal: members can see their match in the app even if the email never
// arrives, while the server still cannot read it (device-held private keys).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeKey, generateDeviceKey, openSealedMatch, unwrapMatchKey } from '../public/lib/sealed.js';
import { setup } from './helpers.js';

const t = setup();

async function device(cookie) {
  const key = await generateDeviceKey();
  const r = await t.call('POST', '/devices', { cookie, body: { publicKey: key.publicKey } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...key, id: r.data.deviceId };
}

async function openOnPortal(exId, cookie, dev) {
  const r = await t.call('GET', `/exchanges/${exId}/my-match`, { cookie });
  assert.equal(r.status, 200);
  const wrap = r.data.wraps.find((w) => w.deviceId === dev.id);
  if (!wrap) return null;
  const key = await unwrapMatchKey(dev.privateKey, wrap, r.data.slotId, dev.id);
  return openSealedMatch(r.data.sealed, key, r.data.slotId);
}

describe('portal reveal', () => {
  test('rejects junk device keys', async () => {
    const u = await t.login('junk@example.com', 'Junk');
    for (const publicKey of [undefined, 'abc', btoa('x'.repeat(65)), 'A'.repeat(500)]) {
      assert.equal((await t.call('POST', '/devices', { cookie: u.cookie, body: { publicKey } })).status, 400);
    }
    assert.equal((await t.call('POST', '/devices', { body: { publicKey: 'abc' } })).status, 401);
  });

  test('everyone sees their match in the app, matching the email, without the email link', async () => {
    const names = ['Ana', 'Bob', 'Cid', 'Dia'];
    const users = {};
    for (const n of names) {
      users[n] = await t.login(`portal-${n}@example.com`, n);
      users[n].device = await device(users[n].cookie);
    }
    // Ana has a second device (e.g. a phone) too.
    users.Ana.phone = await device(users.Ana.cookie);
    const created = await t.call('POST', '/exchanges', { cookie: users.Ana.cookie, body: { name: 'Portal', names, selfIndex: 0 } });
    const exId = created.data.id;
    const ex = (await t.call('GET', `/exchanges/${exId}`, { cookie: users.Ana.cookie })).data.exchange;
    const token = ex.inviteUrl.split('#/join/')[1];
    const before = t.emails.length;
    for (const n of names.slice(1)) {
      const slotId = ex.slots.find((s) => s.name === n).id;
      await t.call('POST', `/invites/${token}/join`, { cookie: users[n].cookie, body: { slotId } });
    }
    await t.flush();
    const mails = t.matchEmails(before);
    assert.equal(mails.length, 4);

    for (const n of names) {
      const fromPortal = await openOnPortal(exId, users[n].cookie, users[n].device);
      const mail = mails.find((m) => m.giver === n);
      assert.equal(fromPortal.name, mail.giftee, `${n}: portal and email agree`);
    }
    assert.equal((await openOnPortal(exId, users.Ana.cookie, users.Ana.phone)).name, mails.find((m) => m.giver === 'Ana').giftee);

    // Another person's private key cannot unwrap your key, even if they got the wrap.
    const bobView = (await t.call('GET', `/exchanges/${exId}/my-match`, { cookie: users.Bob.cookie })).data;
    await assert.rejects(unwrapMatchKey(users.Cid.device.privateKey, bobView.wraps[0], bobView.slotId, users.Bob.device.id));
    // ...and you only ever receive wraps for your own devices.
    assert.deepEqual(
      bobView.wraps.map((w) => w.deviceId),
      [users.Bob.device.id],
    );
    // Wrapped keys cannot be replayed for another slot or device id (bound via HKDF info + AAD).
    await assert.rejects(unwrapMatchKey(users.Bob.device.privateKey, bobView.wraps[0], 'another-slot-id-xxxxxx', users.Bob.device.id));

    // A device registered after the draw gets nothing (the email link still works there).
    const late = await device(users.Dia.cookie);
    assert.equal(await openOnPortal(exId, users.Dia.cookie, late), null);
    const diaMail = mails.find((m) => m.giver === 'Dia');
    const diaView = (await t.call('GET', `/exchanges/${exId}/my-match`, { cookie: users.Dia.cookie })).data;
    assert.equal((await openSealedMatch(diaView.sealed, decodeKey(diaMail.key), diaView.slotId)).name, diaMail.giftee);
  });

  test('the database never holds anything that opens a match', async () => {
    const { results: wraps } = await t.env.DB.prepare('SELECT * FROM match_key_wraps').all();
    const { results: devices } = await t.env.DB.prepare('SELECT * FROM device_keys').all();
    assert.ok(wraps.length > 0);
    // Public keys are 65-byte uncompressed points: no private key material is ever sent.
    for (const d of devices) assert.equal(atob(d.public_key).length, 65);
  });

  test('a match is still shown on the portal when every email bounces', async () => {
    const saved = t.env.APP_URL;
    const names = ['Eli', 'Fen', 'Gia', 'Hob'];
    const users = {};
    for (const n of names) {
      users[n] = await t.login(`bounce-${n}@example.com`, n);
      users[n].device = await device(users[n].cookie);
    }
    const created = await t.call('POST', '/exchanges', { cookie: users.Eli.cookie, body: { name: 'Bounce', names, selfIndex: 0 } });
    const exId = created.data.id;
    const ex = (await t.call('GET', `/exchanges/${exId}`, { cookie: users.Eli.cookie })).data.exchange;
    const token = ex.inviteUrl.split('#/join/')[1];
    for (const n of names.slice(1, 3)) {
      await t.call('POST', `/invites/${token}/join`, { cookie: users[n].cookie, body: { slotId: ex.slots.find((s) => s.name === n).id } });
    }
    // Break email delivery (console mode refuses non-localhost URLs) for the draw.
    t.env.APP_URL = 'https://broken.example';
    try {
      await t.call('POST', `/invites/${token}/join`, {
        cookie: users.Hob.cookie,
        body: { slotId: ex.slots.find((s) => s.name === 'Hob').id },
      });
      await t.flush();
    } finally {
      t.env.APP_URL = saved;
    }
    const view = (await t.call('GET', `/exchanges/${exId}`, { cookie: users.Eli.cookie })).data.exchange;
    assert.ok(view.slots.every((s) => s.emailStatus === 'failed'));
    const seen = new Set();
    for (const n of names) {
      const m = await openOnPortal(exId, users[n].cookie, users[n].device);
      assert.ok(m && m.name !== n);
      seen.add(m.name);
    }
    assert.equal(seen.size, 4, 'everyone still gets a valid, distinct match');
  });
});
