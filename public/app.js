// Secret Santa - single page app. No build step, no third-party JS, strict CSP.
// All user-provided text is escaped by the `html` tagged template below.

import { openSealedMatch, unwrapMatchKey } from './lib/sealed.js';
import { ensureDevice } from './lib/device.js';

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

class Raw {
  constructor(v) {
    this.v = v;
  }
}
const raw = (v) => new Raw(v);
const esc = (s) => String(s).replace(/[&<>"'`=]/g, (c) => `&#${c.charCodeAt(0)};`);
function render(v) {
  if (v instanceof Raw) return v.v;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
/** Tagged template that escapes every interpolated value unless wrapped in raw(). */
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s + (i < vals.length ? render(vals[i]) : '');
  });
  return raw(out);
}
function mount(tpl) {
  app.innerHTML = `<div class="view">${tpl.v}</div>`;
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

const session = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  del(k) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}
function formatDate(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T12:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body, { raw: rawBody, contentType } = {}) {
  const headers = { 'x-requested-with': 'secret-santa' };
  let payload;
  if (rawBody) {
    payload = rawBody;
    headers['content-type'] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    if (res.status === 401) {
      state.user = null;
      renderNav();
      remember(location.hash);
      go('#/login');
    }
    throw new ApiError(res.status, data.error || 'Something went wrong.');
  }
  return data;
}

// ---------------------------------------------------------------------------
// UI bits: toasts, dialogs, buttons, confetti, snow
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

function confirmDialog({ title, body, confirm = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = html` <h3>${title}</h3>
      <p class="muted">${body}</p>
      ${
        typeToConfirm
          ? html`<div class="field">
              <label for="dlg-type">Type <b>${typeToConfirm}</b> to confirm</label><input id="dlg-type" autocomplete="off" />
            </div>`
          : ''
      }
      <div class="actions end">
        <button class="btn btn-ghost" value="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${confirm}</button>
      </div>`.v;
    document.body.append(dlg);
    const okBtn = $('[value=ok]', dlg);
    const typeInput = $('#dlg-type', dlg);
    if (typeInput) {
      okBtn.disabled = true;
      typeInput.addEventListener('input', () => {
        okBtn.disabled = typeInput.value !== typeToConfirm;
      });
    }
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    okBtn.addEventListener('click', () => done(typeInput ? typeInput.value : true));
    $('[value=cancel]', dlg).addEventListener('click', () => done(false));
    dlg.addEventListener('cancel', () => done(false));
    dlg.showModal();
  });
}

/** Run an async action while showing a spinner on the button. */
async function busy(btn, fn) {
  if (btn.disabled) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    return await fn();
  } catch (err) {
    toast(err.message || 'Something went wrong.', 'error');
    return undefined;
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function snow() {
  if (reduceMotion) return;
  const c = $('#snow');
  const ctx = c.getContext('2d');
  let w;
  let h;
  let flakes = [];
  const resize = () => {
    w = c.width = innerWidth * devicePixelRatio;
    h = c.height = innerHeight * devicePixelRatio;
    c.style.width = `${innerWidth}px`;
    c.style.height = `${innerHeight}px`;
    const n = Math.min(140, Math.round(innerWidth / 9));
    flakes = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: (Math.random() * 2 + 0.6) * devicePixelRatio,
      s: (Math.random() * 0.6 + 0.25) * devicePixelRatio,
      d: Math.random() * Math.PI * 2,
    }));
  };
  resize();
  addEventListener('resize', resize);
  const tick = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (const f of flakes) {
      f.y += f.s;
      f.d += 0.01;
      f.x += Math.sin(f.d) * 0.4 * devicePixelRatio;
      if (f.y > h + 5) {
        f.y = -5;
        f.x = Math.random() * w;
      }
      ctx.globalAlpha = 0.35 + f.r / (4 * devicePixelRatio);
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!document.hidden) requestAnimationFrame(tick);
    else setTimeout(() => requestAnimationFrame(tick), 500);
  };
  tick();
}

function confetti() {
  if (reduceMotion) return;
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = devicePixelRatio;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  c.style.width = `${innerWidth}px`;
  c.style.height = `${innerHeight}px`;
  const colors = ['#f2c36b', '#e0445f', '#ffdf9e', '#2f9b74', '#ffffff', '#8fb3ff'];
  const parts = Array.from({ length: 180 }, () => ({
    x: c.width / 2,
    y: c.height / 2.4,
    vx: (Math.random() - 0.5) * 22 * dpr,
    vy: (Math.random() - 1) * 20 * dpr,
    s: (Math.random() * 6 + 4) * dpr,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frames = 0;
  const tick = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.vy += 0.5 * dpr;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (++frames < 200) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, c.width, c.height);
  };
  tick();
}

// ---------------------------------------------------------------------------
// state, routing
// ---------------------------------------------------------------------------

const state = { user: undefined, config: null };
let renderSeq = 0;

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
function remember(hash) {
  if (hash && /^#\/(join|s)\//.test(hash)) session.set('ss-next', hash);
}
function takeRemembered() {
  const next = session.get('ss-next');
  session.del('ss-next');
  return next && /^#\/(join\/[A-Za-z0-9_-]{43}|s\/[A-Za-z0-9_-]{22})$/.test(next) ? next : null;
}

async function loadMe() {
  try {
    const { user } = await api('GET', '/me');
    state.user = user;
  } catch {
    state.user = null;
  }
  state.device = state.user ? setupDevice(state.user) : Promise.resolve(null);
  renderNav();
}

/** Register this browser's device key so matches can be unlocked here, on the portal. */
async function setupDevice(user) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.email));
    const accountKey = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return await ensureDevice(accountKey, user.deviceIds || [], (publicKey) => api('POST', '/devices', { publicKey }));
  } catch {
    return null;
  }
}

function renderNav() {
  const nav = $('#nav');
  if (!state.user) {
    nav.innerHTML = '';
    return;
  }
  nav.innerHTML = html` <a class="btn btn-ghost btn-sm" href="#/home">My sessions</a>
    <a class="user-pill" href="#/profile" aria-label="Your profile">
      <span class="avatar">${initial(state.user.name)}</span><span class="label">${state.user.name || 'Profile'}</span>
    </a>`.v;
}

const routes = [
  [/^#\/?$/, () => (state.user ? go('#/home') : viewLogin())],
  [/^#\/login(?:\?(.*))?$/, (m) => viewLogin(new URLSearchParams(m[1] || ''))],
  [/^#\/welcome(?:\?(.*))?$/, (m) => auth(() => viewWelcome(new URLSearchParams(m[1] || '')))],
  [/^#\/home$/, () => auth(viewHome)],
  [/^#\/new$/, () => auth(viewNew)],
  [/^#\/profile$/, () => auth(viewProfile)],
  [/^#\/s\/([A-Za-z0-9_-]{22})$/, (m) => auth(() => viewSession(m[1]))],
  [/^#\/s\/([A-Za-z0-9_-]{22})\/edit$/, (m) => auth(() => viewEdit(m[1]))],
  [/^#\/join\/([A-Za-z0-9_-]{43})$/, (m) => auth(() => viewJoin(m[1]))],
];

function auth(fn) {
  if (!state.user) {
    remember(location.hash);
    return go('#/login');
  }
  if (!state.user.name && !location.hash.startsWith('#/welcome')) {
    remember(location.hash);
    return go('#/welcome');
  }
  return fn();
}

async function route() {
  renderSeq++;
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(m);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) viewError(err.message);
      }
      return;
    }
  }
  viewError("That page doesn't exist.");
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

const PHILIP_LINES = [
  'Is it for me?',
  'I like socks. Just saying.',
  'A gift? For ME?',
  "I've been SO good this year.",
  'Psst… who did you get?',
  'Mugs are always welcome.',
];
const QUIPS = [
  'No Philips were harmed in the making of this website.',
  'Philip has been notified. Philip is thrilled.',
  'Philip would like you to know he is not peeking.',
  'Philip once asked for a gift. Look what happened.',
  'Certified 100% Philip-approved encryption.',
  'Philip says: "socks are a valid gift". Philip is right.',
];
const NO_DEVICE =
  "This browser can't store your secret key (private window or blocked storage?), so you couldn't see your match later. Please use a normal browser window.";
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function viewError(message) {
  mount(
    html` <div class="narrow card empty">
      <img class="philip-small" src="/philip.svg" alt="" width="110" height="119" />
      <h2>Philip looked everywhere…</h2>
      <p class="muted">${message}</p>
      <a class="btn btn-primary" href="#/">Take me home</a>
    </div>`,
  );
}

const ICONS = {
  google: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>',
  ),
  apple: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-3.8zM14 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4z"/></svg>',
  ),
};

async function viewLogin(params = new URLSearchParams()) {
  if (state.user) return go(takeRemembered() || '#/home');
  const providers = state.config?.providers || [];
  const next = session.get('ss-next');
  const ret = next && next.startsWith('#/join/') ? `?return=${encodeURIComponent(next)}` : '';
  mount(
    html` <section class="hero">
      <div>
        <div class="hero-art">
          <img class="philip" src="/philip.svg" alt="Philip, wearing a party hat, looking hopeful" width="210" height="228" />
          <span class="bubble" aria-hidden="true">${pick(PHILIP_LINES)}</span>
        </div>
        <span class="sticker">Secret Santa, but make it secret</span>
        <h1 class="card-gap">Philip wanted a gift.</h1>
        <p class="scribble">So now everyone's getting one.</p>
        <p class="lead">
          Gather your people, draw names in secret, and finally buy Philip that novelty mug. Simple to start, impossible to peek.
        </p>
        <ul class="promises">
          <li>
            <span class="ico" aria-hidden="true">🔒</span
            ><span><b>Your email stays private</b>Encrypted at rest and never shown to anyone. Not the organiser, not even Philip.</span>
          </li>
          <li>
            <span class="ico" aria-hidden="true">🤫</span
            ><span
              ><b>Nobody can peek at the pairs</b>Not the organiser, not whoever runs this site. Your match is locked to your own devices,
              and only you can open it.</span
            >
          </li>
          <li>
            <span class="ico" aria-hidden="true">✨</span
            ><span
              ><b>Draws itself</b>The moment the last person joins, names are drawn and everyone sees their match right here. Zero admin,
              maximum chaos.</span
            >
          </li>
        </ul>
      </div>
      <div class="card" id="login-card">
        <h2>Sign in</h2>
        <p class="muted">One profile for all your Secret Santas, this year and every year.</p>
        ${params.get('error') ? html`<p class="toast error">${params.get('error')}</p>` : ''}
        ${
          providers.length
            ? html`<div class="actions">
                  ${providers.includes('google') ? html`<a class="btn btn-social btn-block" href="/api/auth/oauth/google/start${ret}">${ICONS.google} Continue with Google</a>` : ''}
                  ${providers.includes('apple') ? html`<a class="btn btn-apple btn-block" href="/api/auth/oauth/apple/start${ret}">${ICONS.apple} Continue with Apple</a>` : ''}
                </div>
                <div class="divider">or use a one-time code</div>`
            : ''
        }
        <form id="email-form" novalidate>
          <div class="field">
            <label for="email">Email address</label>
            <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required maxlength="254" />
          </div>
          <div id="turnstile"></div>
          <button class="btn btn-primary btn-block" type="submit">Email me a code</button>
        </form>
        <form id="code-form" hidden novalidate>
          <p class="muted">We sent a 6-digit code to <b id="sent-to"></b>. It expires in 10 minutes.</p>
          <div class="otp" role="group" aria-label="6 digit code">
            ${[0, 1, 2, 3, 4, 5].map((i) => html`<input inputmode="numeric" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" maxlength="6" aria-label="Digit ${i + 1}" data-i="${i}" />`)}
          </div>
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
          <div class="actions card-gap-sm"><button class="btn btn-ghost btn-sm" type="button" id="back">Use a different email</button></div>
        </form>
      </div>
    </section>`,
  );

  let turnstileToken = null;
  if (state.config?.turnstileSiteKey) {
    loadTurnstile().then((ts) => {
      ts.render('#turnstile', {
        sitekey: state.config.turnstileSiteKey,
        theme: 'dark',
        callback: (t) => {
          turnstileToken = t;
        },
        'expired-callback': () => {
          turnstileToken = null;
        },
      });
    });
  }

  const emailForm = $('#email-form');
  const codeForm = $('#code-form');
  const digits = $$('.otp input');
  let email = '';

  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    email = $('#email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Please enter a valid email.', 'error');
    busy($('button[type=submit]', emailForm), async () => {
      await api('POST', '/auth/request-otp', { email, turnstileToken });
      $('#sent-to').textContent = email;
      emailForm.hidden = true;
      codeForm.hidden = false;
      digits[0].focus();
    });
  });
  $('#back').addEventListener('click', () => {
    codeForm.hidden = true;
    emailForm.hidden = false;
    digits.forEach((d) => (d.value = ''));
    if (window.turnstile) window.turnstile.reset();
  });

  digits.forEach((d, i) => {
    d.addEventListener('input', () => {
      const v = d.value.replace(/\D/g, '');
      if (v.length > 1) {
        // pasted / autofilled the whole code
        v.slice(0, 6)
          .split('')
          .forEach((ch, j) => (digits[j].value = ch));
        digits[Math.min(v.length, 6) - 1].focus();
      } else {
        d.value = v;
        if (v && i < 5) digits[i + 1].focus();
      }
      if (digits.every((x) => x.value)) codeForm.requestSubmit();
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !d.value && i > 0) digits[i - 1].focus();
    });
  });

  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = digits.map((d) => d.value).join('');
    if (code.length !== 6) return toast('Enter all 6 digits.', 'error');
    busy($('button[type=submit]', codeForm), async () => {
      try {
        const res = await api('POST', '/auth/verify-otp', { email, code });
        await loadMe();
        go(res.needsName ? '#/welcome' : takeRemembered() || '#/home');
      } catch (err) {
        digits.forEach((x) => (x.value = ''));
        digits[0].focus();
        throw err;
      }
    });
  });
}

let turnstilePromise;
function loadTurnstile() {
  turnstilePromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = reject;
    document.head.append(s);
  });
  return turnstilePromise;
}

function viewWelcome(params) {
  mount(
    html` <div class="narrow card">
      <div class="eyebrow">Welcome aboard</div>
      <h2>What should we call you?</h2>
      <p class="muted">This is just for your profile. In each Secret Santa you'll pick the name the organiser added for you.</p>
      <form id="name-form">
        <div class="field">
          <label for="name">Your name</label
          ><input id="name" maxlength="40" autocomplete="name" required value="${state.user.name || ''}" />
        </div>
        <button class="btn btn-primary btn-block" type="submit">Let's go</button>
      </form>
    </div>`,
  );
  $('#name').focus();
  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button', e.target), async () => {
      await api('PATCH', '/me', { name: $('#name').value });
      await loadMe();
      const next = params.get('next');
      go(takeRemembered() || (next && /^#\/join\/[A-Za-z0-9_-]{43}$/.test(next) ? next : '#/home'));
    });
  });
}

async function viewHome() {
  const next = takeRemembered();
  if (next) return go(next);
  const seq = renderSeq;
  const { exchanges } = await api('GET', '/exchanges');
  if (seq !== renderSeq) return;
  const first = state.user.name.split(' ')[0];
  mount(
    html` <div class="page-head">
        <div>
          <div class="eyebrow">Your sessions</div>
          <h1>Hello, <span class="gold">${first}</span></h1>
          ${first.toLowerCase() === 'philip' ? html`<span class="sticker berry">Yes, it's your website. No, you can't peek.</span>` : ''}
        </div>
        <a class="btn btn-gold" href="#/new">＋ Start a Secret Santa</a>
      </div>
      ${
        exchanges.length
          ? html`<div class="grid">${exchanges.map(tile)}</div>`
          : html`<div class="card empty">
              <img class="philip-small" src="/philip.svg" alt="" width="110" height="119" />
              <h2>No Secret Santas yet</h2>
              <p class="muted">
                Philip is staring at you expectantly. Start one for your friends, or open an invite link someone sent you.
              </p>
              <a class="btn btn-primary" href="#/new">Start your first one</a>
            </div>`
      }`,
  );
}

function tile(x) {
  const pct = Math.round((x.joined / Math.max(1, x.total)) * 100);
  return html` <a class="tile" href="#/s/${x.id}">
    <div class="tile-photo">
      ${x.hasPhoto ? html`<img src="/api/exchanges/${x.id}/photo" alt="" loading="lazy" />` : html`<div class="placeholder" aria-hidden="true">🎄</div>`}
    </div>
    <div class="tile-body">
      <h3>${x.name}</h3>
      <div class="meta">
        ${x.status === 'drawn' ? html`<span class="pill green">✓ Names drawn</span>` : html`<span class="pill">${x.joined}/${x.total} joined</span>`}
        ${x.isCreator ? html`<span class="pill gold">Organiser</span>` : ''} ${x.budget ? html`<span class="pill">${x.budget}</span>` : ''}
      </div>
      ${x.status === 'open' ? html`<div class="progress"><span class="w-${pct}"></span></div>` : ''}
    </div>
  </a>`;
}

// Progress widths without inline styles (CSP): generate classes on the fly.
(function progressClasses() {
  const sheet = new CSSStyleSheet();
  let rules = '';
  for (let i = 0; i <= 100; i++) rules += `.w-${i}{width:${i}%}.p-${i}{--p:${i}}`;
  sheet.replaceSync(rules);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})();

// ---------------------------------------------------------------------------
// create / edit
// ---------------------------------------------------------------------------

const CURRENCIES = ['£', '$', '€', '₹', '¥', 'A$', 'C$', 'CHF', 'kr', 'R'];

function splitBudget(budget) {
  if (!budget) return { cur: '£', amount: '' };
  for (const c of [...CURRENCIES].sort((a, b) => b.length - a.length)) {
    if (budget.startsWith(c)) return { cur: c, amount: budget.slice(c.length).trim() };
  }
  return { cur: '£', amount: budget };
}

function detailsFields(ex = {}) {
  const b = splitBudget(ex.budget);
  return html` <div class="field">
      <label for="f-name">Session name</label>
      <input id="f-name" maxlength="60" required placeholder="The Flat 4 Christmas Chaos" value="${ex.name || ''}" />
    </div>
    <div class="row stack-sm">
      <div class="field">
        <label for="f-amount">Budget per gift</label>
        <div class="row">
          <select id="f-cur" class="shrink" aria-label="Currency">
            ${CURRENCIES.map((c) => html`<option ${c === b.cur ? 'selected' : ''}>${c}</option>`)}
          </select>
          <input id="f-amount" inputmode="decimal" maxlength="12" placeholder="25" value="${b.amount}" />
        </div>
      </div>
      <div class="field">
        <label for="f-date">Gift exchange day</label>
        <input id="f-date" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(ex.eventDate || '') ? ex.eventDate : ''}" />
      </div>
    </div>
    <div class="field">
      <label for="f-msg">A note for everyone <span class="faint">(optional)</span></label>
      <textarea id="f-msg" maxlength="500" placeholder="Dress code: questionable jumpers. Mulled wine provided.">
${ex.message || ''}</textarea>
    </div>`;
}

function readDetails() {
  const amount = $('#f-amount').value.trim();
  return {
    name: $('#f-name').value,
    budget: amount ? `${$('#f-cur').value}${amount}` : null,
    eventDate: $('#f-date').value || null,
    message: $('#f-msg').value || null,
  };
}

function photoField(currentSrc) {
  return html` <div class="field">
    <label>Group photo <span class="faint">(optional, the quirkier the better)</span></label>
    <label class="photo-drop ${currentSrc ? 'has-img' : ''}" id="photo-drop">
      ${currentSrc ? html`<img src="${currentSrc}" alt="Group photo preview" />` : ''}
      <span class="cap">📸 ${currentSrc ? 'Change photo' : 'Tap to add a photo'}</span>
      <input type="file" id="photo-input" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" />
    </label>
    <div class="hint">Location data and other hidden details are removed before upload. Only people in this session can see it.</div>
  </div>`;
}

/** Re-encode an image in the browser: strips EXIF/GPS metadata and shrinks it. */
async function processImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image.');
  if (file.size > 30 * 1024 * 1024) throw new Error('That image is huge. Please pick one under 30 MB.');
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("Couldn't read that image. Try a JPEG or PNG.");
  }
  const max = 1400;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.75, 0.62, 0.5]) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size < 700 * 1024) return blob;
  }
  throw new Error('That photo is too detailed to shrink. Try another one.');
}

function bindPhotoField(onBlob) {
  const input = $('#photo-input');
  const drop = $('#photo-drop');
  const handle = async (file) => {
    if (!file) return;
    try {
      const blob = await processImage(file);
      const url = URL.createObjectURL(blob);
      drop.classList.add('has-img');
      drop.innerHTML = html`<img src="${url}" alt="Group photo preview" /><span class="cap">📸 Change photo</span>`.v;
      drop.append(input);
      onBlob(blob);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  input.addEventListener('change', () => handle(input.files[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    handle(e.dataTransfer.files[0]);
  });
}

function namesEditor(container, names, { onChange, lockedNote } = {}) {
  const draw = () => {
    container.innerHTML = html` <div class="row">
        <input id="name-input" maxlength="40" placeholder="Add a name, e.g. Priya" aria-label="Add a name" />
        <button type="button" class="btn shrink" id="name-add">Add</button>
      </div>
      <div class="hint">Tip: paste a list separated by commas or new lines. Use names your friends will recognise as themselves.</div>
      <div class="chips">
        ${names.map(
          (n, i) =>
            html`<span class="chip ${n.joined ? 'taken' : ''}"
              >${n.joined ? '✓ ' : ''}${n.name}<button type="button" data-rm="${i}" aria-label="Remove ${n.name}">×</button></span
            >`,
        )}
      </div>
      <p class="faint">
        ${names.length}
        ${names.length === 1 ? 'person' : 'people'}${names.length < 4 ? ' · you need at least 4 (with 3, everyone could work out every pair)' : ''}${lockedNote ? ` · ${lockedNote}` : ''}
      </p>`.v;
    const input = $('#name-input', container);
    const add = () => {
      const parts = input.value
        .split(/[,\n]/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      for (const p of parts) {
        if (p.length > 40) {
          toast(`"${p.slice(0, 20)}…" is too long.`, 'error');
          continue;
        }
        if (names.some((n) => n.name.toLowerCase() === p.toLowerCase())) {
          toast(`${p} is already on the list.`, 'error');
          continue;
        }
        if (names.length >= 50) {
          toast('That is the maximum of 50 people.', 'error');
          break;
        }
        names.push({ name: p, isNew: true });
      }
      input.value = '';
      draw();
      onChange?.();
      $('#name-input', container).focus();
    };
    $('#name-add', container).addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      }
    });
    input.addEventListener('paste', () => setTimeout(add, 0));
    $$('[data-rm]', container).forEach((b) =>
      b.addEventListener('click', async () => {
        const n = names[Number(b.dataset.rm)];
        if (n.joined) {
          const ok = await confirmDialog({
            title: `Remove ${n.name}?`,
            body: `${n.name} has already joined. Removing them takes them out of this Secret Santa.`,
            confirm: 'Remove',
            danger: true,
          });
          if (!ok) return;
        }
        names.splice(Number(b.dataset.rm), 1);
        draw();
        onChange?.();
      }),
    );
  };
  draw();
}

function viewNew() {
  const names = [];
  let photo = null;
  mount(
    html` <div class="mid">
      <div class="page-head">
        <div>
          <div class="eyebrow">New Secret Santa</div>
          <h1>Let's set the scene</h1>
        </div>
      </div>
      <form id="new-form" novalidate>
        <div class="card">
          <h3 class="card-title">The details</h3>
          ${detailsFields()} ${photoField(null)}
        </div>
        <div class="card">
          <h3 class="card-title">Who's in?</h3>
          <div id="names"></div>
        </div>
        <div class="card">
          <h3 class="card-title">Are you taking part?</h3>
          <div class="field">
            <label for="self">I am…</label
            ><select id="self">
              <option value="">Just organising, not taking part</option>
            </select>
          </div>
          <div class="field" id="wish-field" hidden>
            <label for="wish">Your wishlist or hints <span class="faint">(optional)</span></label>
            <textarea id="wish" maxlength="500" placeholder="Fluffy socks, anything with cats, no more mugs please"></textarea>
          </div>
        </div>
        <div class="actions end card-gap" id="create-actions">
          <a class="btn btn-ghost" href="#/home">Cancel</a>
          <button class="btn btn-primary" type="submit">Create session ✨</button>
        </div>
      </form>
    </div>`,
  );
  const refreshSelf = () => {
    const sel = $('#self');
    const cur = sel.value;
    sel.innerHTML = html`<option value="">Just organising, not taking part</option>
      ${names.map((n, i) => html`<option value="${i}" ${String(i) === cur ? 'selected' : ''}>${n.name}</option>`)}`.v;
    $('#wish-field').hidden = sel.value === '';
  };
  if (state.user.name) names.push({ name: state.user.name });
  namesEditor($('#names'), names, { onChange: refreshSelf });
  refreshSelf();
  if (names.length) {
    $('#self').value = '0';
    $('#wish-field').hidden = false;
  }
  $('#self').addEventListener('change', () => ($('#wish-field').hidden = $('#self').value === ''));
  bindPhotoField((b) => (photo = b));

  $('#new-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (names.length < 4) return toast('Add at least 4 people. With only 3, everyone could work out who has whom!', 'error');
    busy($('button[type=submit]', e.target), async () => {
      const selfVal = $('#self').value;
      if ($('#self').value !== '' && !(await state.device)) throw new Error(NO_DEVICE);
      const { id } = await api('POST', '/exchanges', {
        ...readDetails(),
        names: names.map((n) => n.name),
        selfIndex: selfVal === '' ? null : Number(selfVal),
        wishlist: selfVal === '' ? null : $('#wish').value,
      });
      if (photo) {
        try {
          await api('PUT', `/exchanges/${id}/photo`, undefined, { raw: photo, contentType: 'image/jpeg' });
        } catch (err) {
          toast(`Session created, but the photo failed: ${err.message}`, 'error');
        }
      }
      toast('Your Secret Santa is ready! Share the invite link.', 'ok');
      go(`#/s/${id}`);
    });
  });
}

async function viewEdit(id) {
  const seq = renderSeq;
  const { exchange: ex } = await api('GET', `/exchanges/${id}`);
  if (seq !== renderSeq) return;
  if (!ex.isCreator || ex.status !== 'open') return go(`#/s/${id}`);
  const names = ex.slots.map((s) => ({ ...s }));
  let photo = null;
  let removePhoto = false;
  mount(
    html` <div class="mid">
      <div class="page-head">
        <div>
          <div class="eyebrow">Edit session</div>
          <h1>${ex.name}</h1>
        </div>
      </div>
      <form id="edit-form" novalidate>
        <div class="card">
          ${detailsFields(ex)}${photoField(ex.hasPhoto ? `/api/exchanges/${id}/photo` : null)}
          ${ex.hasPhoto ? html`<button type="button" class="btn btn-ghost btn-sm" id="photo-rm">Remove photo</button>` : ''}
        </div>
        <div class="card">
          <h3 class="card-title">Who's in?</h3>
          <div id="names"></div>
          <p class="faint">
            If everyone on the list has already joined when you save, names are drawn straight away and the session locks.
          </p>
        </div>
        <div class="actions end card-gap">
          <a class="btn btn-ghost" href="#/s/${id}">Cancel</a>
          <button class="btn btn-primary" type="submit">Save changes</button>
        </div>
      </form>
    </div>`,
  );
  namesEditor($('#names'), names, { lockedNote: '✓ = already joined' });
  bindPhotoField((b) => {
    photo = b;
    removePhoto = false;
  });
  $('#photo-rm')?.addEventListener('click', (e) => {
    removePhoto = true;
    photo = null;
    e.target.remove();
    $('#photo-drop').classList.remove('has-img');
    $('#photo-drop img')?.remove();
  });
  $('#edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (names.length < 4) return toast('You need at least 4 people.', 'error');
    busy($('button[type=submit]', e.target), async () => {
      if (photo) await api('PUT', `/exchanges/${id}/photo`, undefined, { raw: photo, contentType: 'image/jpeg' });
      else if (removePhoto) await api('DELETE', `/exchanges/${id}/photo`);
      const keep = new Set(names.filter((n) => n.id).map((n) => n.id));
      await api('PATCH', `/exchanges/${id}`, {
        ...readDetails(),
        addNames: names.filter((n) => !n.id).map((n) => n.name),
        removeSlotIds: ex.slots.filter((s) => !keep.has(s.id)).map((s) => s.id),
      });
      toast('Saved.', 'ok');
      go(`#/s/${id}`);
    });
  });
}

// ---------------------------------------------------------------------------
// session page
// ---------------------------------------------------------------------------

function banner(ex, photoSrc) {
  return html` <div class="banner">
    ${ex.hasPhoto ? html`<img src="${photoSrc}" alt="Group photo for ${ex.name}" />` : html`<span class="deco" aria-hidden="true">🎄</span>`}
    <div class="shade"></div>
    <div class="banner-body">
      <div class="eyebrow">Organised by ${ex.creatorName}</div>
      <h1>${ex.name}</h1>
      <div class="meta">
        ${ex.budget ? html`<span class="pill gold budget-chip">💰 ${ex.budget} budget</span>` : ''}
        ${ex.eventDate ? html`<span class="pill">📅 ${formatDate(ex.eventDate)}</span>` : ''}
        ${ex.status === 'drawn' ? html`<span class="pill green">🔒 Names drawn</span>` : ''}
      </div>
    </div>
  </div>`;
}

async function viewSession(id) {
  const seq = renderSeq;
  const { exchange: ex } = await api('GET', `/exchanges/${id}`);
  if (seq !== renderSeq) return;
  const joined = ex.slots.filter((s) => s.joined).length;
  const pct = Math.round((joined / ex.slots.length) * 100);
  const drawn = ex.status === 'drawn';
  const locked = drawn && ex.isCreator ? ex.slots.filter((s) => !s.canUnlock).length : 0;

  mount(
    html` ${banner(ex, `/api/exchanges/${id}/photo`)}
      <div class="layout">
        <div>
          ${
            drawn && ex.mySlotId
              ? html`<div class="card reveal" id="reveal-card">
                  <div class="eyebrow">The names are drawn</div>
                  <h2>${ex.myName}, your giftee awaits</h2>
                  <button class="gift" id="gift" aria-label="Open your gift to reveal your match">
                    <span class="lid"><span class="bow" aria-hidden="true">🎀</span></span
                    ><span class="box"></span>
                  </button>
                  <p class="faint" id="gift-hint">Tap the present. Check nobody's looking over your shoulder (especially Philip) 👀</p>
                  <div class="match" id="match"></div>
                </div>`
              : ''
          }
          <div class="card">
            <div class="card-title">
              <h3>The crew</h3>
              <span class="pill">${joined}/${ex.slots.length} joined</span>
            </div>
            <div class="people">
              ${ex.slots.map(
                (s) =>
                  html`<div class="person ${s.joined ? 'joined' : ''} ${s.isMe ? 'me' : ''}">
                    <span class="avatar">${s.joined ? '✓' : initial(s.name)}</span>
                    <span
                      ><span class="nm">${s.name}${s.isMe ? ' (you)' : ''}</span><br /><span class="st"
                        >${s.joined ? 'Joined' : 'Waiting…'}</span
                      ></span
                    >
                  </div>`,
              )}
            </div>
          </div>
          ${
            ex.message
              ? html`<div class="card">
                  <div class="eyebrow">A note from ${ex.creatorName}</div>
                  <p class="italic">${ex.message}</p>
                </div>`
              : ''
          }
        </div>
        <div>
          ${
            !drawn
              ? html`<div class="card center">
                  <div class="ring p-${pct}">
                    <div>
                      <span><b>${joined}</b><small>of ${ex.slots.length}</small></span>
                    </div>
                  </div>
                  <p class="muted">
                    Names are drawn automatically the moment everyone has joined. Then everyone opens their match right here.
                  </p>
                </div>`
              : html`<div class="card">
                  <div class="lock-note">
                    <span aria-hidden="true">🔐</span
                    ><span>This session is locked. Nobody can see who drew whom: not the organiser, and not whoever runs this site.</span>
                  </div>
                </div>`
          }
          ${
            ex.isCreator && !drawn
              ? html`<div class="card">
                  <h3 class="card-title">Invite link</h3>
                  <p class="faint">Share this with the people on the list. Each person signs in and picks their own name.</p>
                  <div class="invite">
                    <input id="invite" readonly value="${ex.inviteUrl}" aria-label="Invite link" /><button class="btn shrink" id="copy">
                      Copy
                    </button>
                  </div>
                  <div class="actions card-gap-sm">
                    ${navigator.share ? html`<button class="btn btn-sm" id="share">Share…</button>` : ''}
                    <button class="btn btn-ghost btn-sm" id="regen">New link</button>
                  </div>
                </div>`
              : ''
          }
          ${
            ex.mySlotId && !drawn
              ? html`<div class="card">
                  <h3 class="card-title">Your wishlist</h3>
                  <p class="faint">Whoever draws you will see this with your name.</p>
                  <textarea id="wishlist" maxlength="500" placeholder="Hints for your Secret Santa">${ex.myWishlist}</textarea>
                  <div class="actions end card-gap-sm"><button class="btn btn-sm" id="save-wish">Save wishlist</button></div>
                </div>`
              : ''
          }
          ${
            ex.isCreator && drawn
              ? html`<div class="card">
                  <h3 class="card-title">Can everyone see their match?</h3>
                  <div class="statuses">
                    ${ex.slots.map(
                      (s) =>
                        html`<div>
                          <span>${s.name}</span
                          ><span class="pill ${s.canUnlock ? 'green' : 'berry'}">${s.canUnlock ? '✓ Ready' : 'No device'}</span>
                        </div>`,
                    )}
                  </div>
                  <p class="faint">
                    ${locked ? html`<b>${locked} ${locked === 1 ? 'person has' : 'people have'} no device that can open their match.</b> ` : ''}Matches
                    are locked to each person's own browser, so nobody (not you, not us) can read or re-send them. If someone can't see
                    theirs, the only fix is a fresh draw for everyone.
                  </p>
                  <button class="btn ${locked ? 'btn-gold' : 'btn-ghost'} btn-sm" id="redraw">Redraw for everyone</button>
                </div>`
              : ''
          }
          <div class="card">
            <div class="actions">
              ${ex.isCreator && !drawn ? html`<a class="btn btn-sm" href="#/s/${id}/edit">Edit session</a>` : ''}
              ${ex.mySlotId && !drawn ? html`<button class="btn btn-ghost btn-sm" id="leave">Leave session</button>` : ''}
              ${ex.isCreator ? html`<button class="btn btn-danger btn-sm" id="delete">Delete session</button>` : ''}
              ${!ex.isCreator && drawn ? html`<span class="faint">Have fun, and keep it secret! 🤫</span>` : ''}
            </div>
          </div>
        </div>
      </div>`,
  );

  $('#copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ex.inviteUrl);
      toast('Invite link copied!', 'ok');
    } catch {
      $('#invite').select();
    }
  });
  $('#share')?.addEventListener('click', () =>
    navigator.share({ title: ex.name, text: `Join our Secret Santa "${ex.name}"!`, url: ex.inviteUrl }).catch(() => {}),
  );
  $('#regen')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Make a new invite link?',
      body: 'The old link will stop working. People who already joined stay in.',
      confirm: 'New link',
    });
    if (ok)
      busy(e.target, async () => {
        const { inviteUrl } = await api('POST', `/exchanges/${id}/invite`);
        $('#invite').value = inviteUrl;
        ex.inviteUrl = inviteUrl;
        toast('New invite link ready.', 'ok');
      });
  });
  $('#save-wish')?.addEventListener('click', (e) =>
    busy(e.target, async () => {
      await api('PUT', `/exchanges/${id}/wishlist`, { wishlist: $('#wishlist').value });
      toast('Wishlist saved.', 'ok');
    }),
  );
  $('#leave')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Leave this Secret Santa?',
      body: 'Your name will be free for someone else to pick.',
      confirm: 'Leave',
      danger: true,
    });
    if (ok)
      busy(e.target, async () => {
        await api('POST', `/exchanges/${id}/leave`);
        toast('You left the session.');
        go(ex.isCreator ? `#/s/${id}` : '#/home');
      });
  });
  $('#delete')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Delete this session?',
      body: "This removes it for everyone, for good, including everyone's matches.",
      confirm: 'Delete forever',
      danger: true,
      typeToConfirm: 'DELETE',
    });
    if (ok)
      busy(e.target, async () => {
        await api('DELETE', `/exchanges/${id}`);
        toast('Session deleted.');
        go('#/home');
      });
  });
  $('#redraw')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: 'Redraw all names?',
      body: "Everyone gets a brand new match and the old ones disappear. Only do this if someone really can't see theirs, and tell everyone to check again!",
      confirm: 'Redraw',
      danger: true,
    });
    if (ok)
      busy(e.target, async () => {
        await api('POST', `/exchanges/${id}/redraw`);
        toast('Names redrawn. Tell everyone to open their new match!', 'ok');
        route();
      });
  });
  $('#gift')?.addEventListener('click', () => revealMatch(id));
}

async function revealMatch(id) {
  const gift = $('#gift');
  if (gift.classList.contains('open')) return;
  const box = $('#match');
  const say = (msg) => {
    box.innerHTML = msg.v;
    box.classList.add('show');
  };
  try {
    const { sealed, slotId, wraps } = await api('GET', `/exchanges/${id}/my-match`);
    // Only this browser's private device key can unlock the match.
    const device = await state.device;
    const wrap = device && wraps.find((w) => w.deviceId === device.id);
    let match = null;
    if (wrap) {
      try {
        match = await openSealedMatch(sealed, await unwrapMatchKey(device.privateKey, wrap, slotId, device.id), slotId);
      } catch {
        /* falls through to the message below */
      }
    }
    if (!match) {
      return say(
        html`<p class="muted">
          🔑 Your match is locked so that only you can open it, and this browser doesn't hold your key. Open this page on the device and
          browser you used <b>before the names were drawn</b>. If that's gone, ask the organiser to redraw.
        </p>`,
      );
    }
    gift.classList.add('open');
    $('#gift-hint').hidden = true;
    box.innerHTML = html` <div class="faint">You're the Secret Santa for</div>
      <div class="name">${match.name}</div>
      ${
        match.wishlist
          ? html`<div class="wish">
              <div class="eyebrow">Their wishlist</div>
              ${match.wishlist}
            </div>`
          : html`<p class="faint">No wishlist yet. Time to be creative!</p>`
      }`.v;
    setTimeout(() => {
      box.classList.add('show');
      confetti();
    }, 350);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

async function viewJoin(token) {
  const seq = renderSeq;
  const { invite } = await api('GET', `/invites/${token}`);
  if (seq !== renderSeq) return;
  if (invite.alreadyJoined) {
    toast(`You're already in ${invite.name}.`);
    return go(`#/s/${invite.exchangeId}`);
  }
  if (invite.status !== 'open') return viewError('The names for this Secret Santa have already been drawn.');
  const free = invite.slots.filter((s) => !s.joined);
  let picked = null;
  mount(
    html` <div class="mid">
      ${banner({ ...invite, hasPhoto: invite.hasPhoto }, `/api/invites/${token}/photo`)}
      <div class="card card-gap">
        <div class="eyebrow">You're invited</div>
        <h2>Which one is you?</h2>
        <p class="muted">Pick your own name. Names already taken are crossed out.</p>
        <div class="pick" id="pick">
          ${invite.slots.map((s) => html`<button type="button" data-id="${s.id}" ${s.joined ? 'disabled' : ''}>${s.name}</button>`)}
        </div>
        ${free.length === 0 ? html`<p class="faint">Every name is taken. If one of them should be you, ask the organiser.</p>` : ''}
        <div class="field card-gap">
          <label for="wish">Your wishlist or hints <span class="faint">(optional, you can change it until names are drawn)</span></label>
          <textarea id="wish" maxlength="500" placeholder="Board games, hot sauce, anything purple…"></textarea>
        </div>
        ${invite.message ? html`<p class="italic muted">“${invite.message}”</p>` : ''}
        <button class="btn btn-primary btn-block" id="join" disabled>Join the fun 🎄</button>
      </div>
    </div>`,
  );
  $$('#pick button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#pick button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      picked = b.dataset.id;
      $('#join').disabled = false;
      $('#join').textContent = `Join as ${b.textContent} 🎄`;
    }),
  );
  $('#join').addEventListener('click', (e) =>
    busy(e.target, async () => {
      if (!(await state.device)) throw new Error(NO_DEVICE);
      const r = await api('POST', `/invites/${token}/join`, { slotId: picked, wishlist: $('#wish').value });
      if (r.drawn) {
        confetti();
        toast('You were the last one in! Names have been drawn. Open your gift below 🎁', 'ok');
      } else toast("You're in! When everyone has joined, your match appears right here. Use this same browser to open it.", 'ok');
      go(`#/s/${r.exchangeId}`);
    }),
  );
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

function viewProfile() {
  mount(
    html` <div class="narrow">
      <div class="page-head">
        <div>
          <div class="eyebrow">Your profile</div>
          <h1>${state.user.name}</h1>
        </div>
      </div>
      <div class="card">
        <form id="profile-form">
          <div class="field"><label for="name">Name</label><input id="name" maxlength="40" required value="${state.user.name}" /></div>
          <div class="field">
            <label>Email</label><input value="${state.user.email}" disabled />
            <div class="hint">Encrypted on our side and never shown to other people.</div>
          </div>
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
      </div>
      <div class="card">
        <h3 class="card-title">Security</h3>
        <div class="actions">
          <button class="btn btn-sm" id="logout">Log out</button>
          <button class="btn btn-sm btn-ghost" id="logout-all">Log out on all devices</button>
        </div>
      </div>
      <div class="card">
        <h3 class="card-title">Danger zone</h3>
        <p class="faint">
          Deleting your account removes your profile and every session you organised. You leave any sessions that haven't been drawn yet.
        </p>
        <button class="btn btn-danger btn-sm" id="delete-me">Delete my account</button>
      </div>
    </div>`,
  );
  $('#profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button', e.target), async () => {
      await api('PATCH', '/me', { name: $('#name').value });
      await loadMe();
      toast('Profile saved.', 'ok');
      viewProfile();
    });
  });
  const out = (all) => async (e) =>
    busy(e.target, async () => {
      await api('POST', all ? '/auth/logout-all' : '/auth/logout');
      state.user = null;
      renderNav();
      go('#/login');
    });
  $('#logout').addEventListener('click', out(false));
  $('#logout-all').addEventListener('click', out(true));
  $('#delete-me').addEventListener('click', async (e) => {
    const typed = await confirmDialog({
      title: 'Delete your account?',
      body: 'This cannot be undone.',
      confirm: 'Delete account',
      danger: true,
      typeToConfirm: 'DELETE',
    });
    if (typed)
      busy(e.target, async () => {
        await api('DELETE', '/me', { confirm: typed });
        state.user = null;
        renderNav();
        toast('Your account has been deleted. Merry everything! 🎄');
        go('#/login');
      });
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  snow();
  $('#quip').textContent = pick(QUIPS);
  try {
    state.config = await api('GET', '/config');
  } catch {
    state.config = { providers: [] };
  }
  await loadMe();
  addEventListener('hashchange', route);
  route();
}

boot();
