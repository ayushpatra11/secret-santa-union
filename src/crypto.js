// Cryptographic helpers built on the Web Crypto API (available in Cloudflare Workers).
//
// A single secret (APP_SECRET) is expanded with HKDF into two independent keys:
//   - an AES-256-GCM key used to encrypt emails, assignments and wishlists at rest
//   - an HMAC-SHA256 key used for blind indexes and for hashing OTPs / tokens
// Leaking the database alone therefore reveals no email addresses or pairings.

const enc = new TextEncoder();
const dec = new TextDecoder();
let cached = { secret: null, keys: null };

export class ConfigError extends Error {}

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getKeys(env) {
  const secret = env.APP_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-me')) {
    throw new ConfigError('APP_SECRET is missing or too short (need 32+ random characters).');
  }
  if (cached.secret === secret) return cached.keys;
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const salt = enc.encode('secret-santa-union/v1');
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('aes-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const mac = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('hmac') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  cached = { secret, keys: { aes, mac } };
  return cached.keys;
}

/** Keyed hash with domain separation, e.g. hmac(env, 'email', 'a@b.c'). Returns hex. */
export async function hmac(env, purpose, value) {
  const { mac } = await getKeys(env);
  const sig = await crypto.subtle.sign('HMAC', mac, enc.encode(`${purpose}\u0000${value}`));
  return toHex(sig);
}

/** AES-256-GCM encrypt. `aad` binds the ciphertext to a context (e.g. a row id). */
export async function encrypt(env, plaintext, aad) {
  const { aes } = await getKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, aes, enc.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64encode(out);
}

export async function decrypt(env, payload, aad) {
  const { aes } = await getKeys(env);
  const raw = b64decode(payload);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, aes, raw.slice(12));
  return dec.decode(pt);
}

/** URL-safe random token. */
export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Uniform random integer in [0, max) using rejection sampling. */
export function randomInt(max) {
  if (max <= 0 || max > 2 ** 32) throw new RangeError('bad max');
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/** 6-digit one-time code. */
export function randomOtp() {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

/** Constant-time comparison of two equal-format strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
