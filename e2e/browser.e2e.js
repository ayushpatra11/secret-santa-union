// Full browser journey against a running `wrangler dev`, signing in through the fake
// local Google in e2e/fake-oidc.js. Four friends sign up, the organiser creates a session
// with a group photo, the others join from the invite link, the draw fires, and each
// person opens their own match in the app. No emails exist anywhere in this flow.
//
//   BASE_URL=http://localhost:8788 node --test e2e/   (or just: npm run test:e2e)

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8788';
const SHOTS = process.env.SCREENSHOT_DIR;
const run = Date.now().toString(36);
let browser;

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

async function newUser(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const email = `${name.toLowerCase()}-${run}@example.com`;
  await page.goto(BASE);
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.getByLabel('Email').fill(email); // the fake Google's form
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: "Let's go" }).click();
  await page.getByRole('heading', { name: new RegExp(`Hello, ${name}`) }).waitFor();
  return { page, context, errors, name };
}

test('four friends complete a Secret Santa in the browser', async () => {
  const ayush = await newUser('Ayush');
  await shot(ayush.page, '01-home-empty');

  // Create a session
  await ayush.page
    .getByRole('link', { name: /Start a Secret Santa/ })
    .first()
    .click();
  await ayush.page.getByLabel('Session name').fill('Flat 4 Chaos');
  await ayush.page.getByLabel('Budget per gift').fill('25');
  await ayush.page.getByLabel('Gift exchange day').fill('2026-12-20');
  await ayush.page.getByLabel('A note for everyone').fill('Questionable jumpers mandatory.');
  // A real PNG via the photo picker (processed + re-encoded client side).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
    'base64',
  );
  await ayush.page.locator('#photo-input').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: png });
  const add = ayush.page.getByLabel('Add a name');
  for (const n of ['Bea', 'Cal', 'Dev']) {
    await add.fill(n);
    await add.press('Enter');
  }
  await ayush.page.getByLabel('Your wishlist or hints').fill('Fluffy socks');
  await shot(ayush.page, '02-create');
  await ayush.page.getByRole('button', { name: /Create session/ }).click();
  await ayush.page.getByRole('heading', { name: 'Flat 4 Chaos' }).waitFor();
  await ayush.page.getByText('£25 budget').waitFor();
  const invite = await ayush.page.getByLabel('Invite link').inputValue();
  assert.match(invite, /#\/join\/[A-Za-z0-9_-]{43}$/);
  await shot(ayush.page, '03-session-open');

  // Friends join
  const bea = await newUser('Bea');
  await bea.page.goto(invite);
  await bea.page.getByRole('button', { name: 'Bea', exact: true }).click();
  await bea.page.getByLabel(/Your wishlist or hints/).fill('Books!');
  await shot(bea.page, '04-join');
  await bea.page.getByRole('button', { name: /Join as Bea/ }).click();
  await bea.page.getByText("You're in!").waitFor();

  const cal = await newUser('Cal');
  await cal.page.goto(invite);
  assert.ok(await cal.page.getByRole('button', { name: 'Bea', exact: true }).isDisabled(), 'taken names are disabled');
  await cal.page.getByRole('button', { name: 'Cal', exact: true }).click();
  await cal.page.getByRole('button', { name: /Join as Cal/ }).click();
  await cal.page.getByText("You're in!").waitFor();

  const dev = await newUser('Dev');
  await dev.page.goto(invite);
  await dev.page.getByRole('button', { name: 'Dev', exact: true }).click();
  await dev.page.getByRole('button', { name: /Join as Dev/ }).click();
  await dev.page.getByText('Names have been drawn').waitFor();

  // Everyone opens their match in the app: no emails involved at all.
  const matches = {};
  for (const person of [ayush, bea, cal, dev]) {
    await person.page.goto(`${BASE}/#/home`);
    await person.page.getByRole('link', { name: /Flat 4 Chaos/ }).click();
    await person.page.getByRole('button', { name: /Open your gift/ }).click();
    await person.page.locator('.match .name').waitFor();
    matches[person.name] = (await person.page.locator('.match .name').textContent()).trim();
    assert.notEqual(matches[person.name], person.name, `${person.name} drew themselves`);
    if (person === ayush) await shot(person.page, '05-reveal');
  }
  assert.equal(new Set(Object.values(matches)).size, 4, 'everyone is drawn exactly once');

  // A browser that wasn't used before the draw can't open it, even when logged in.
  const ayushOtherDevice = await browser.newContext();
  await ayushOtherDevice.addCookies(await ayush.context.cookies());
  const p2 = await ayushOtherDevice.newPage();
  await p2.goto(`${BASE}/#/home`);
  await p2.getByRole('link', { name: /Flat 4 Chaos/ }).click();
  await p2.getByRole('button', { name: /Open your gift/ }).click();
  await p2.getByText(/this browser doesn't hold your key/).waitFor();
  assert.equal(await p2.locator('.match .name').count(), 0);

  // Organiser view: locked, who can open their match, no pairs.
  await ayush.page.goto(`${BASE}/#/home`);
  await ayush.page.getByRole('link', { name: /Flat 4 Chaos/ }).click();
  await ayush.page.getByText('This session is locked').waitFor();
  await ayush.page.getByText('Can everyone see their match?').waitFor();
  assert.equal(await ayush.page.getByRole('link', { name: 'Edit session' }).count(), 0);
  await shot(ayush.page, '06-organiser-drawn');

  for (const p of [ayush, bea, cal, dev]) assert.deepEqual(p.errors, [], `${p.name} saw console errors`);
});
