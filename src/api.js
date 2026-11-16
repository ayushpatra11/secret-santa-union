import { ConfigError, decrypt, encrypt, hmac, randomOtp, randomToken, safeEqual } from './crypto.js';
import { drawPairs } from './draw.js';
import { assignmentEmail, otpEmail, sendEmail } from './email.js';
import { HttpError, assertSameOrigin, cleanText, getCookie, json, normaliseEmail, readJson } from './http.js';
import { BINDING_COOKIE, configuredProviders, finishOAuth, startOAuth } from './oauth.js';
import { importDevicePublicKey, wrapForDevice } from './sealing.js';

const SESSION_COOKIE = '__Host-ss_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// With 3 people, knowing your own match reveals every pair, so 4 is the minimum.
const MIN_PEOPLE = 4;
const MAX_PEOPLE = 50;
const MAX_EXCHANGES_PER_USER = 25;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

const now = () => Date.now();
const newId = () => randomToken(16);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handle(request, env, ctx) {
  try {
    // `await` matters: it makes async errors land in the catch below.
    return await dispatch(request, env, ctx);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof ConfigError) {
      console.error('Config error:', err.message);
      return json({ error: `Server misconfigured: ${err.message}` }, 500);
    }
    console.error('Unhandled error:', err && err.message);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

async function dispatch(request, env, ctx) {
  {
    if (!env.DB) throw new ConfigError('D1 database binding "DB" is missing.');
    if (Math.random() < 0.05) ctx.waitUntil(cleanup(env).catch(() => {}));
    const url = new URL(request.url);
    const parts = url.pathname
      .replace(/^\/api\/?/, '')
      .split('/')
      .filter(Boolean);
    const route = `${request.method} /${parts.join('/')}`;

    // OAuth redirects are top-level navigations (Apple's is even a cross-site POST),
    // so they are protected by state + PKCE + cookie binding instead of the origin check.
    if (parts[0] === 'auth' && parts[1] === 'oauth' && parts.length === 4) {
      if (parts[3] === 'start' && request.method === 'GET') return oauthStart(request, env, parts[2], url);
      if (parts[3] === 'callback' && (request.method === 'GET' || request.method === 'POST')) {
        return oauthCallback(request, env, parts[2], url);
      }
    }

    assertSameOrigin(request);

    switch (route) {
      case 'GET /config':
        return json({
          providers: configuredProviders(env),
          turnstileSiteKey: env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY || null : null,
        });
      case 'POST /auth/request-otp':
        return requestOtp(request, env);
      case 'POST /auth/verify-otp':
        return verifyOtp(request, env);
      case 'POST /auth/logout':
        return logout(request, env, false);
      case 'POST /auth/logout-all':
        return logout(request, env, true);
      case 'GET /me':
        return getMe(request, env);
      case 'PATCH /me':
        return updateMe(request, env);
      case 'POST /devices':
        return registerDevice(request, env);
      case 'DELETE /me':
        return deleteMe(request, env);
      case 'GET /exchanges':
        return listExchanges(request, env);
      case 'POST /exchanges':
        return createExchange(request, env);
    }

    if (parts[0] === 'exchanges' && parts[1]) {
      if (!ID_RE.test(parts[1])) throw new HttpError(404, 'Not found');
      const id = parts[1];
      const sub = parts.slice(2).join('/');
      const m = request.method;
      if (m === 'GET' && sub === '') return getExchange(request, env, id);
      if (m === 'PATCH' && sub === '') return updateExchange(request, env, ctx, id);
      if (m === 'DELETE' && sub === '') return deleteExchange(request, env, id);
      if (m === 'POST' && sub === 'invite') return regenerateInvite(request, env, id);
      if (m === 'POST' && sub === 'leave') return leaveExchange(request, env, id);
      if (m === 'PUT' && sub === 'wishlist') return updateWishlist(request, env, id);
      if (m === 'GET' && sub === 'my-match') return myMatch(request, env, id);
      if (m === 'POST' && sub === 'redraw') return redraw(request, env, ctx, id);
      if (m === 'GET' && sub === 'photo') return getPhoto(request, env, id);
      if (m === 'PUT' && sub === 'photo') return putPhoto(request, env, id);
      if (m === 'DELETE' && sub === 'photo') return deletePhoto(request, env, id);
    }
    if (parts[0] === 'invites' && parts[1]) {
      if (!TOKEN_RE.test(parts[1])) throw new HttpError(404, 'This invite link is not valid.');
      if (request.method === 'GET' && parts.length === 2) return previewInvite(request, env, parts[1]);
      if (request.method === 'POST' && parts[2] === 'join') return joinInvite(request, env, ctx, parts[1]);
      if (request.method === 'GET' && parts[2] === 'photo') {
        await requireUser(request, env);
        const ex = await exchangeByInvite(env, parts[1]);
        return photoResponse(env, ex.id);
      }
    }
    throw new HttpError(404, 'Not found');
  }
}

// ---------------------------------------------------------------------------
// Helpers: rate limiting, auth, cleanup
// ---------------------------------------------------------------------------

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'local';
}

/** Fixed-window rate limit. Keys are HMAC'd so no raw IPs/emails are stored. */
async function rateLimit(env, rawKey, limit, windowSec) {
  const key = await hmac(env, 'ratelimit', rawKey);
  const t = now();
  const start = t - windowSec * 1000;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     RETURNING count`,
  )
    .bind(key, t, start)
    .first();
  if (row.count > limit) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

async function cleanup(env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM otps WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 24 * 3600 * 1000),
  ]);
}

async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.display_name, u.email_enc, s.expires_at FROM auth_sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(await hmac(env, 'session', token))
    .first();
  if (!row || row.expires_at < now()) return null;
  return row;
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Please log in first.');
  return user;
}

function sessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

/** Find-or-create the user for a verified email and open a fresh session. */
async function loginWithEmail(env, email) {
  const emailHash = await hmac(env, 'email', email);
  let user = await env.DB.prepare('SELECT id, display_name FROM users WHERE email_hash = ?').bind(emailHash).first();
  let isNew = false;
  if (!user) {
    const id = newId();
    await env.DB.prepare('INSERT OR IGNORE INTO users (id, email_hash, email_enc, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, emailHash, await encrypt(env, email, `email:${id}`), '', now())
      .run();
    user = await env.DB.prepare('SELECT id, display_name FROM users WHERE email_hash = ?').bind(emailHash).first();
    isNew = true;
  }
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await hmac(env, 'session', token), user.id, now() + SESSION_TTL_MS, now())
    .run();
  return { user, isNew, cookie: sessionCookie(token, SESSION_TTL_MS / 1000) };
}

async function verifyTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET_KEY) return;
  if (typeof token !== 'string' || !token || token.length > 2048) throw new HttpError(400, 'Please complete the human check.');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: clientIp(request) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new HttpError(400, 'Human check failed. Please try again.');
}

// ---------------------------------------------------------------------------
// Auth: email OTP
// ---------------------------------------------------------------------------

async function requestOtp(request, env) {
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  await rateLimit(env, `otp-ip:${clientIp(request)}`, 10, 15 * 60);
  await verifyTurnstile(env, request, body.turnstileToken);
  const emailHash = await hmac(env, 'email', email);
  await rateLimit(env, `otp-email:${emailHash}`, 3, 15 * 60);

  const code = randomOtp();
  await env.DB.prepare('INSERT OR REPLACE INTO otps (email_hash, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)')
    .bind(emailHash, await hmac(env, 'otp', `${emailHash}:${code}`), now() + OTP_TTL_MS)
    .run();
  try {
    await sendEmail(env, { to: email, ...otpEmail(env, code) });
  } catch (err) {
    console.error('OTP email failed:', err.message);
    throw new HttpError(502, "We couldn't send the email right now. Please try again shortly.");
  }
  // Same response whether or not the account exists (no account enumeration).
  return json({ ok: true });
}

async function verifyOtp(request, env) {
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'The code is 6 digits.');
  await rateLimit(env, `verify-ip:${clientIp(request)}`, 30, 15 * 60);
  const emailHash = await hmac(env, 'email', email);
  await rateLimit(env, `verify-email:${emailHash}`, 15, 60 * 60);

  const otp = await env.DB.prepare('SELECT * FROM otps WHERE email_hash = ?').bind(emailHash).first();
  const invalid = new HttpError(400, 'That code is wrong or has expired.');
  if (!otp || otp.expires_at < now()) throw invalid;
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM otps WHERE email_hash = ?').bind(emailHash).run();
    throw new HttpError(429, 'Too many wrong codes. Please request a new one.');
  }
  const expected = await hmac(env, 'otp', `${emailHash}:${code}`);
  if (!safeEqual(expected, otp.code_hash)) {
    await env.DB.prepare('UPDATE otps SET attempts = attempts + 1 WHERE email_hash = ?').bind(emailHash).run();
    throw invalid;
  }
  // Single use: only the request that actually deletes the row wins.
  const del = await env.DB.prepare('DELETE FROM otps WHERE email_hash = ? AND code_hash = ?').bind(emailHash, expected).run();
  if (del.meta.changes !== 1) throw invalid;

  const { user, isNew, cookie } = await loginWithEmail(env, email);
  return json({ ok: true, needsName: isNew || !user.display_name }, 200, { 'set-cookie': cookie });
}

async function logout(request, env, everywhere) {
  const user = await currentUser(request, env);
  const token = getCookie(request, SESSION_COOKIE);
  if (user && everywhere) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(user.id).run();
  } else if (token && TOKEN_RE.test(token)) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(await hmac(env, 'session', token))
      .run();
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

// ---------------------------------------------------------------------------
// Auth: Google / Apple
// ---------------------------------------------------------------------------

function safeReturnTo(value) {
  return typeof value === 'string' && /^#\/join\/[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
}

async function oauthStart(request, env, provider, url) {
  await rateLimit(env, `oauth-ip:${clientIp(request)}`, 20, 15 * 60);
  const { location, bindingCookie } = await startOAuth(env, provider, safeReturnTo(url.searchParams.get('return')));
  return redirect(location, [bindingCookie]);
}

async function oauthCallback(request, env, provider, url) {
  const base = (env.APP_URL || url.origin).replace(/\/+$/, '');
  const clearBinding = `${BINDING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
  try {
    let params = url.searchParams;
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > 16 * 1024) throw new HttpError(413, 'Request too large');
      params = new URLSearchParams(text);
    }
    if (params.get('error')) throw new HttpError(400, 'Sign-in was cancelled.');
    const { email, returnTo } = await finishOAuth(env, provider, {
      code: params.get('code'),
      state: params.get('state'),
      binding: getCookie(request, BINDING_COOKIE),
    });
    const { user, isNew, cookie } = await loginWithEmail(env, normaliseEmail(email));
    const target =
      isNew || !user.display_name ? `#/welcome${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ''}` : returnTo || '#/home';
    return redirect(`${base}/${target}`, [cookie, clearBinding]);
  } catch (err) {
    const msg = err instanceof HttpError ? err.message : 'Sign-in failed. Please try again.';
    if (!(err instanceof HttpError)) console.error('OAuth error:', err && err.message);
    return redirect(`${base}/#/login?error=${encodeURIComponent(msg)}`, [clearBinding]);
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function getMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null });
  const email = await decrypt(env, user.email_enc, `email:${user.id}`);
  const { results: devices } = await env.DB.prepare('SELECT id FROM device_keys WHERE user_id = ?').bind(user.id).all();
  return json({ user: { name: user.display_name, email, deviceIds: devices.map((d) => d.id) } });
}

async function updateMe(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const name = cleanText(body.name, { field: 'Name', min: 1, max: 40 });
  await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, user.id).run();
  return json({ ok: true });
}

async function deleteMe(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM match_key_wraps WHERE slot_id IN (SELECT s.id FROM slots s JOIN exchanges e ON e.id = s.exchange_id WHERE e.creator_id = ?)`,
    ).bind(user.id),
    env.DB.prepare(`DELETE FROM slots WHERE exchange_id IN (SELECT id FROM exchanges WHERE creator_id = ?)`).bind(user.id),
    env.DB.prepare(`DELETE FROM exchange_photos WHERE exchange_id IN (SELECT id FROM exchanges WHERE creator_id = ?)`).bind(user.id),
    env.DB.prepare('DELETE FROM exchanges WHERE creator_id = ?').bind(user.id),
    // Free up slots in sessions that haven't been drawn yet.
    env.DB.prepare(
      `UPDATE slots SET user_id = NULL, claimed_at = NULL, wishlist_enc = NULL WHERE user_id = ?
       AND exchange_id IN (SELECT id FROM exchanges WHERE status = 'open')`,
    ).bind(user.id),
    env.DB.prepare('UPDATE slots SET user_id = NULL WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM match_key_wraps WHERE device_id IN (SELECT id FROM device_keys WHERE user_id = ?)').bind(user.id),
    env.DB.prepare('DELETE FROM device_keys WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

// ---------------------------------------------------------------------------
// Exchanges (a.k.a. "sessions" in the UI)
// ---------------------------------------------------------------------------

function cleanNames(list, field = 'Names') {
  if (!Array.isArray(list)) throw new HttpError(400, `${field} must be a list`);
  return list.map((n) => cleanText(n, { field: 'Each name', min: 1, max: 40 }));
}

function assertUniqueNames(names) {
  const seen = new Set();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) throw new HttpError(400, `"${n}" appears twice. Names must be unique.`);
    seen.add(k);
  }
}

function cleanDetails(body) {
  return {
    name: cleanText(body.name, { field: 'Session name', min: 1, max: 60 }),
    budget: cleanText(body.budget, { field: 'Budget', max: 40, optional: true }),
    eventDate: cleanText(body.eventDate, { field: 'Date', max: 40, optional: true }),
    message: cleanText(body.message, { field: 'Message', max: 500, optional: true, multiline: true }),
  };
}

async function inviteUrl(env, exchange) {
  const token = await decrypt(env, exchange.invite_enc, `invite:${exchange.id}`);
  return `${(env.APP_URL || '').replace(/\/+$/, '')}/#/join/${token}`;
}

async function loadExchange(env, id) {
  const ex = await env.DB.prepare('SELECT * FROM exchanges WHERE id = ?').bind(id).first();
  if (!ex) throw new HttpError(404, 'This session no longer exists.');
  return ex;
}

const OPEN_GUARD = `EXISTS (SELECT 1 FROM exchanges WHERE id = ? AND status = 'open')`;

async function listExchanges(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.name, e.status, e.event_date, e.budget, e.created_at, e.creator_id = ?1 AS is_creator,
            (SELECT COUNT(*) FROM slots WHERE exchange_id = e.id) AS total,
            (SELECT COUNT(*) FROM slots WHERE exchange_id = e.id AND user_id IS NOT NULL) AS joined,
            s.name AS my_name,
            EXISTS (SELECT 1 FROM exchange_photos WHERE exchange_id = e.id) AS has_photo
     FROM exchanges e LEFT JOIN slots s ON s.exchange_id = e.id AND s.user_id = ?1
     WHERE e.creator_id = ?1 OR s.id IS NOT NULL
     ORDER BY e.created_at DESC`,
  )
    .bind(user.id)
    .all();
  return json({
    exchanges: results.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      eventDate: r.event_date,
      budget: r.budget,
      isCreator: !!r.is_creator,
      total: r.total,
      joined: r.joined,
      myName: r.my_name,
      hasPhoto: !!r.has_photo,
    })),
  });
}

async function createExchange(request, env) {
  const user = await requireUser(request, env);
  await rateLimit(env, `create:${user.id}`, 10, 60 * 60);
  const body = await readJson(request);
  const details = cleanDetails(body);
  const names = cleanNames(body.names);
  if (names.length < MIN_PEOPLE) throw new HttpError(400, `A Secret Santa needs at least ${MIN_PEOPLE} people.`);
  if (names.length > MAX_PEOPLE) throw new HttpError(400, `At most ${MAX_PEOPLE} people per session.`);
  assertUniqueNames(names);
  const selfIndex = Number.isInteger(body.selfIndex) && body.selfIndex >= 0 && body.selfIndex < names.length ? body.selfIndex : null;
  const wishlist = selfIndex !== null ? cleanText(body.wishlist, { field: 'Wishlist', max: 500, optional: true, multiline: true }) : null;

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE creator_id = ?').bind(user.id).first();
  if (count.n >= MAX_EXCHANGES_PER_USER) throw new HttpError(400, 'You have created too many sessions. Delete an old one first.');

  const id = newId();
  const invite = randomToken(32);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO exchanges (id, creator_id, name, budget, event_date, message, invite_hash, invite_enc, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).bind(
      id,
      user.id,
      details.name,
      details.budget,
      details.eventDate,
      details.message,
      await hmac(env, 'invite', invite),
      await encrypt(env, invite, `invite:${id}`),
      now(),
    ),
  ];
  for (let i = 0; i < names.length; i++) {
    const slotId = newId();
    const mine = i === selfIndex;
    stmts.push(
      env.DB.prepare(
        'INSERT INTO slots (id, exchange_id, position, name, user_id, wishlist_enc, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        slotId,
        id,
        i,
        names[i],
        mine ? user.id : null,
        mine && wishlist ? await encrypt(env, wishlist, `wishlist:${slotId}`) : null,
        mine ? now() : null,
      ),
    );
  }
  await env.DB.batch(stmts);
  return json({ id }, 201);
}

async function getExchange(request, env, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  const { results: slots } = await env.DB.prepare(
    'SELECT id, name, user_id, email_status, wishlist_enc FROM slots WHERE exchange_id = ? ORDER BY position',
  )
    .bind(id)
    .all();
  const isCreator = ex.creator_id === user.id;
  const mine = slots.find((s) => s.user_id === user.id);
  if (!isCreator && !mine) throw new HttpError(404, 'This session no longer exists.');
  const creator = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(ex.creator_id).first();

  return json({
    exchange: {
      id: ex.id,
      name: ex.name,
      budget: ex.budget,
      eventDate: ex.event_date,
      message: ex.message,
      status: ex.status,
      drawnAt: ex.drawn_at,
      creatorName: creator?.display_name || 'The organiser',
      isCreator,
      hasPhoto: !!(await env.DB.prepare('SELECT 1 FROM exchange_photos WHERE exchange_id = ?').bind(id).first()),
      inviteUrl: isCreator && ex.status === 'open' ? await inviteUrl(env, ex) : null,
      mySlotId: mine?.id || null,
      myName: mine?.name || null,
      myWishlist: mine?.wishlist_enc ? await decrypt(env, mine.wishlist_enc, `wishlist:${mine.id}`) : '',
      // Only names and whether a spot is taken. Never emails, never who drew whom.
      slots: slots.map((s) => ({
        id: s.id,
        name: s.name,
        joined: !!s.user_id,
        isMe: s.user_id === user.id,
        ...(isCreator && ex.status === 'drawn' ? { emailStatus: s.email_status } : {}),
      })),
    },
  });
}

async function updateExchange(request, env, ctx, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) throw new HttpError(403, 'Only the organiser can change this session.');
  if (ex.status !== 'open') throw new HttpError(409, 'Names have been drawn. This session is locked.');
  const body = await readJson(request);
  const details = cleanDetails({ name: ex.name, budget: ex.budget, eventDate: ex.event_date, message: ex.message, ...body });
  const addNames = body.addNames ? cleanNames(body.addNames, 'addNames') : [];
  const removeIds = Array.isArray(body.removeSlotIds) ? body.removeSlotIds.filter((s) => typeof s === 'string' && ID_RE.test(s)) : [];

  const { results: slots } = await env.DB.prepare('SELECT id, name, position FROM slots WHERE exchange_id = ?').bind(id).all();
  const remaining = slots.filter((s) => !removeIds.includes(s.id));
  const finalNames = [...remaining.map((s) => s.name), ...addNames];
  if (finalNames.length < MIN_PEOPLE) throw new HttpError(400, `A Secret Santa needs at least ${MIN_PEOPLE} people.`);
  if (finalNames.length > MAX_PEOPLE) throw new HttpError(400, `At most ${MAX_PEOPLE} people per session.`);
  assertUniqueNames(finalNames);

  let pos = slots.reduce((m, s) => Math.max(m, s.position), -1) + 1;
  const stmts = [
    env.DB.prepare(`UPDATE exchanges SET name = ?, budget = ?, event_date = ?, message = ? WHERE id = ? AND status = 'open'`).bind(
      details.name,
      details.budget,
      details.eventDate,
      details.message,
      id,
    ),
  ];
  for (const sid of removeIds) {
    stmts.push(env.DB.prepare(`DELETE FROM slots WHERE id = ? AND exchange_id = ? AND ${OPEN_GUARD}`).bind(sid, id, id));
  }
  for (const n of addNames) {
    stmts.push(
      env.DB.prepare(`INSERT INTO slots (id, exchange_id, position, name) SELECT ?, ?, ?, ? WHERE ${OPEN_GUARD}`).bind(
        newId(),
        id,
        pos++,
        n,
        id,
      ),
    );
  }
  await env.DB.batch(stmts);
  await maybeDraw(env, ctx, id);
  return json({ ok: true });
}

async function deleteExchange(request, env, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) throw new HttpError(403, 'Only the organiser can delete this session.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM match_key_wraps WHERE slot_id IN (SELECT id FROM slots WHERE exchange_id = ?)').bind(id),
    env.DB.prepare('DELETE FROM slots WHERE exchange_id = ?').bind(id),
    env.DB.prepare('DELETE FROM exchange_photos WHERE exchange_id = ?').bind(id),
    env.DB.prepare('DELETE FROM exchanges WHERE id = ? AND creator_id = ?').bind(id, user.id),
  ]);
  return json({ ok: true });
}

async function regenerateInvite(request, env, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) throw new HttpError(403, 'Only the organiser can do that.');
  if (ex.status !== 'open') throw new HttpError(409, 'This session is locked.');
  const invite = randomToken(32);
  await env.DB.prepare(`UPDATE exchanges SET invite_hash = ?, invite_enc = ? WHERE id = ? AND status = 'open'`)
    .bind(await hmac(env, 'invite', invite), await encrypt(env, invite, `invite:${id}`), id)
    .run();
  return json({ inviteUrl: await inviteUrl(env, { id, invite_enc: await encrypt(env, invite, `invite:${id}`) }) });
}

async function leaveExchange(request, env, id) {
  const user = await requireUser(request, env);
  const res = await env.DB.prepare(
    `UPDATE slots SET user_id = NULL, claimed_at = NULL, wishlist_enc = NULL WHERE exchange_id = ? AND user_id = ? AND ${OPEN_GUARD}`,
  )
    .bind(id, user.id, id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, "You can't leave once names have been drawn.");
  return json({ ok: true });
}

async function updateWishlist(request, env, id) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const wishlist = cleanText(body.wishlist, { field: 'Wishlist', max: 500, optional: true, multiline: true });
  const slot = await env.DB.prepare('SELECT id FROM slots WHERE exchange_id = ? AND user_id = ?').bind(id, user.id).first();
  if (!slot) throw new HttpError(404, 'You are not part of this session.');
  const res = await env.DB.prepare(`UPDATE slots SET wishlist_enc = ? WHERE id = ? AND ${OPEN_GUARD}`)
    .bind(wishlist ? await encrypt(env, wishlist, `wishlist:${slot.id}`) : null, slot.id, id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'Names have already been drawn, so wishlists are locked.');
  return json({ ok: true });
}

async function myMatch(request, env, id) {
  const user = await requireUser(request, env);
  await rateLimit(env, `match:${user.id}`, 60, 60 * 60);
  const slot = await env.DB.prepare('SELECT id, giftee_enc FROM slots WHERE exchange_id = ? AND user_id = ?').bind(id, user.id).first();
  if (!slot) throw new HttpError(404, 'You are not part of this session.');
  if (!slot.giftee_enc) throw new HttpError(409, "Names haven't been drawn yet.");
  // Sealed with a key only the member has (from their email link). We cannot open it.
  // Wraps of the one-time key for each of this member's registered devices. Only the
  // browser holding the matching private key can unwrap one.
  const { results: wraps } = await env.DB.prepare(
    `SELECT w.device_id AS deviceId, w.epk, w.wrapped FROM match_key_wraps w
     JOIN device_keys d ON d.id = w.device_id WHERE w.slot_id = ? AND d.user_id = ?`,
  )
    .bind(slot.id, user.id)
    .all();
  return json({ sealed: slot.giftee_enc, slotId: slot.id, wraps });
}

/**
 * The server cannot resend a match it does not know. If any email failed (or never
 * went out), the organiser can redraw: everyone gets a brand-new match and a new email.
 */
async function redraw(request, env, ctx, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) throw new HttpError(403, 'Only the organiser can do that.');
  if (ex.status !== 'drawn') throw new HttpError(409, "Names haven't been drawn yet.");
  const stuck = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM slots WHERE exchange_id = ? AND (email_status = 'failed' OR (email_status IN ('pending', 'none') AND ? < ?))`,
  )
    .bind(id, ex.drawn_at, now() - 5 * 60 * 1000)
    .first();
  if (!stuck.n) throw new HttpError(409, 'Every email was delivered, so there is nothing to redraw.');
  await rateLimit(env, `redraw:${id}`, 3, 60 * 60);
  const deliveries = await drawAndSeal(env, id);
  const result = await deliverMatches(env, id, deliveries, true);
  return json({ ok: true, ...result });
}

// ---------------------------------------------------------------------------
// Devices (portal reveal)
// ---------------------------------------------------------------------------

const MAX_DEVICES = 10;

async function registerDevice(request, env) {
  const user = await requireUser(request, env);
  await rateLimit(env, `device:${user.id}`, 20, 60 * 60);
  const body = await readJson(request);
  try {
    await importDevicePublicKey(body.publicKey);
  } catch {
    throw new HttpError(400, 'Invalid device key.');
  }
  const id = newId();
  await env.DB.prepare('INSERT INTO device_keys (id, user_id, public_key, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, user.id, body.publicKey, now())
    .run();
  // Keep the newest few devices per person.
  await env.DB.prepare(
    `DELETE FROM device_keys WHERE user_id = ?1 AND id NOT IN (SELECT id FROM device_keys WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`,
  )
    .bind(user.id)
    .run();
  return json({ deviceId: id }, 201);
}

// ---------------------------------------------------------------------------
// Group photo
// ---------------------------------------------------------------------------

const MAX_PHOTO_BYTES = 750 * 1024;

function sniffImage(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP')
    return 'image/webp';
  return null;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function putPhoto(request, env, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) throw new HttpError(403, 'Only the organiser can change the photo.');
  if (ex.status !== 'open') throw new HttpError(409, 'This session is locked.');
  await rateLimit(env, `photo:${user.id}`, 20, 60 * 60);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too large.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too large.');
  const mime = sniffImage(bytes);
  if (!mime) throw new HttpError(415, 'Please upload a JPEG, PNG or WebP image.');
  const data = await encrypt(env, bytesToB64(bytes), `photo:${id}`);
  const res = await env.DB.prepare(
    `INSERT INTO exchange_photos (exchange_id, mime, data_enc, updated_at) SELECT ?1, ?2, ?3, ?4 WHERE ${OPEN_GUARD.replace('?', '?1')}
     ON CONFLICT(exchange_id) DO UPDATE SET mime = excluded.mime, data_enc = excluded.data_enc, updated_at = excluded.updated_at`,
  )
    .bind(id, mime, data, now())
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'This session is locked.');
  return json({ ok: true });
}

async function deletePhoto(request, env, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) throw new HttpError(403, 'Only the organiser can change the photo.');
  if (ex.status !== 'open') throw new HttpError(409, 'This session is locked.');
  await env.DB.prepare('DELETE FROM exchange_photos WHERE exchange_id = ?').bind(id).run();
  return json({ ok: true });
}

async function getPhoto(request, env, id) {
  const user = await requireUser(request, env);
  const ex = await loadExchange(env, id);
  if (ex.creator_id !== user.id) {
    const member = await env.DB.prepare('SELECT 1 FROM slots WHERE exchange_id = ? AND user_id = ?').bind(id, user.id).first();
    if (!member) throw new HttpError(404, 'Not found');
  }
  return photoResponse(env, id);
}

async function photoResponse(env, id) {
  const row = await env.DB.prepare('SELECT mime, data_enc FROM exchange_photos WHERE exchange_id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'No photo');
  const bytes = Uint8Array.from(atob(await decrypt(env, row.data_enc, `photo:${id}`)), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': row.mime,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

async function exchangeByInvite(env, token) {
  const ex = await env.DB.prepare('SELECT * FROM exchanges WHERE invite_hash = ?')
    .bind(await hmac(env, 'invite', token))
    .first();
  if (!ex) throw new HttpError(404, 'This invite link is not valid any more. Ask the organiser for a new one.');
  return ex;
}

async function previewInvite(request, env, token) {
  const user = await requireUser(request, env);
  await rateLimit(env, `invite:${user.id}`, 60, 15 * 60);
  const ex = await exchangeByInvite(env, token);
  const { results: slots } = await env.DB.prepare('SELECT id, name, user_id FROM slots WHERE exchange_id = ? ORDER BY position')
    .bind(ex.id)
    .all();
  const creator = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(ex.creator_id).first();
  return json({
    invite: {
      exchangeId: ex.id,
      name: ex.name,
      budget: ex.budget,
      eventDate: ex.event_date,
      message: ex.message,
      status: ex.status,
      creatorName: creator?.display_name || 'The organiser',
      alreadyJoined: slots.some((s) => s.user_id === user.id),
      hasPhoto: !!(await env.DB.prepare('SELECT 1 FROM exchange_photos WHERE exchange_id = ?').bind(ex.id).first()),
      slots: slots.map((s) => ({ id: s.id, name: s.name, joined: !!s.user_id })),
    },
  });
}

async function joinInvite(request, env, ctx, token) {
  const user = await requireUser(request, env);
  await rateLimit(env, `invite:${user.id}`, 60, 15 * 60);
  const body = await readJson(request);
  if (typeof body.slotId !== 'string' || !ID_RE.test(body.slotId)) throw new HttpError(400, 'Pick your name from the list.');
  const wishlist = cleanText(body.wishlist, { field: 'Wishlist', max: 500, optional: true, multiline: true });
  const ex = await exchangeByInvite(env, token);
  if (ex.status !== 'open') throw new HttpError(409, 'Names for this session have already been drawn.');

  let res;
  try {
    res = await env.DB.prepare(
      `UPDATE slots SET user_id = ?, claimed_at = ?, wishlist_enc = ?
       WHERE id = ? AND exchange_id = ? AND user_id IS NULL AND ${OPEN_GUARD}`,
    )
      .bind(user.id, now(), wishlist ? await encrypt(env, wishlist, `wishlist:${body.slotId}`) : null, body.slotId, ex.id, ex.id)
      .run();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'You have already joined this session.');
    throw err;
  }
  if (res.meta.changes !== 1) throw new HttpError(409, 'Someone has already taken that name. If that was not you, tell the organiser.');
  const drawn = await maybeDraw(env, ctx, ex.id);
  return json({ ok: true, exchangeId: ex.id, drawn });
}

// ---------------------------------------------------------------------------
// The draw
//
// Zero-knowledge for the operator: pairings exist in plaintext only in memory during
// the request that draws them. Each giver's match is encrypted with a brand-new random
// key that is NOT derived from APP_SECRET and is never stored - it travels only inside
// that giver's email link (in the URL #fragment, which browsers never send to servers).
// The database keeps ciphertext the server itself cannot open. So whoever runs the site,
// even with full database access and every secret, cannot look up who has whom.
// ---------------------------------------------------------------------------

/** If every spot is taken, atomically lock the session, draw names and send emails. */
async function maybeDraw(env, ctx, id) {
  const lock = await env.DB.prepare(
    `UPDATE exchanges SET status = 'drawn', drawn_at = ?1 WHERE id = ?2 AND status = 'open'
       AND NOT EXISTS (SELECT 1 FROM slots WHERE exchange_id = ?2 AND user_id IS NULL)
       AND (SELECT COUNT(*) FROM slots WHERE exchange_id = ?2) >= ${MIN_PEOPLE}`,
  )
    .bind(now(), id)
    .run();
  if (lock.meta.changes !== 1) return false;
  const deliveries = await drawAndSeal(env, id);
  ctx.waitUntil(deliverMatches(env, id, deliveries, false).catch((e) => console.error('Sending matches failed:', e.message)));
  return true;
}

function bytesToB64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Draw pairs, store sealed matches, and return the in-memory email jobs (never persisted). */
async function drawAndSeal(env, id) {
  const { results: slots } = await env.DB.prepare(
    `SELECT s.id, s.name, s.wishlist_enc, u.id AS uid, u.email_enc
     FROM slots s LEFT JOIN users u ON u.id = s.user_id WHERE s.exchange_id = ?`,
  )
    .bind(id)
    .all();
  const byId = new Map(slots.map((s) => [s.id, s]));
  const pairs = drawPairs(
    slots.map((s) => s.id),
    MIN_PEOPLE,
  );
  const { results: devices } = await env.DB.prepare(
    `SELECT d.id, d.user_id, d.public_key FROM device_keys d
     WHERE d.user_id IN (SELECT user_id FROM slots WHERE exchange_id = ? AND user_id IS NOT NULL)`,
  )
    .bind(id)
    .all();
  // A redraw replaces every earlier sealed match and wrapped key.
  const stmts = [env.DB.prepare('DELETE FROM match_key_wraps WHERE slot_id IN (SELECT id FROM slots WHERE exchange_id = ?)').bind(id)];
  const deliveries = [];
  for (const [giverId, gifteeId] of pairs) {
    const giver = byId.get(giverId);
    const giftee = byId.get(gifteeId);
    const wishlist = giftee.wishlist_enc ? await decrypt(env, giftee.wishlist_enc, `wishlist:${giftee.id}`) : '';
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`match:${giverId}`) },
        key,
        new TextEncoder().encode(JSON.stringify({ name: giftee.name, wishlist })),
      ),
    );
    const sealed = new Uint8Array(12 + ct.length);
    sealed.set(iv);
    sealed.set(ct, 12);
    stmts.push(env.DB.prepare(`UPDATE slots SET giftee_enc = ?, email_status = 'pending' WHERE id = ?`).bind(bytesToB64(sealed), giverId));
    for (const d of devices.filter((x) => x.user_id === giver.uid)) {
      try {
        const { epk, wrapped } = await wrapForDevice(d.public_key, rawKey, giverId, d.id);
        stmts.push(
          env.DB.prepare('INSERT INTO match_key_wraps (slot_id, device_id, epk, wrapped) VALUES (?, ?, ?, ?)').bind(
            giverId,
            d.id,
            epk,
            wrapped,
          ),
        );
      } catch {
        // A corrupt device key only loses that device; the email link still works.
      }
    }
    deliveries.push({
      slotId: giverId,
      giverName: giver.name,
      uid: giver.uid,
      emailEnc: giver.email_enc,
      gifteeName: giftee.name,
      wishlist,
      key: bytesToB64url(rawKey),
    });
  }
  await env.DB.batch(stmts);
  return deliveries;
}

async function deliverMatches(env, id, deliveries, isRedraw) {
  const ex = await loadExchange(env, id);
  const base = (env.APP_URL || '').replace(/\/+$/, '');
  let sent = 0;
  let failed = 0;
  for (const d of deliveries) {
    try {
      if (!d.uid) throw new Error('member account no longer exists');
      const email = await decrypt(env, d.emailEnc, `email:${d.uid}`);
      await sendEmail(env, {
        to: email,
        toName: d.giverName,
        ...assignmentEmail(env, {
          giverName: d.giverName,
          gifteeName: d.gifteeName,
          wishlist: d.wishlist,
          exchange: ex,
          revealUrl: `${base}/#/reveal/${id}/${d.key}`,
          isRedraw,
        }),
      });
      await env.DB.prepare(`UPDATE slots SET email_status = 'sent' WHERE id = ?`).bind(d.slotId).run();
      sent++;
    } catch (err) {
      console.error('Match email failed:', err.message);
      await env.DB.prepare(`UPDATE slots SET email_status = 'failed' WHERE id = ?`).bind(d.slotId).run();
      failed++;
    }
  }
  return { sent, failed };
}
