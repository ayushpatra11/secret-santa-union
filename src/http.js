export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extra } });
}

export async function readJson(request, maxBytes = 16 * 1024) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected JSON');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large');
  try {
    const body = JSON.parse(text || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Block cross-site state-changing requests (CSRF defence on top of SameSite=Strict). */
export function assertSameOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (origin) {
    if (origin !== url.origin) throw new HttpError(403, 'Cross-origin request blocked');
  } else if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  if (request.headers.get('x-requested-with') !== 'secret-santa') {
    throw new HttpError(403, 'Missing request header');
  }
}

// ---- input validation -------------------------------------------------------

// Control characters, zero-width characters and bidi overrides (used for spoofing).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function cleanText(value, { field, max, min = 0, multiline = false, optional = false }) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    if (min > 0) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  let v = value.replace(CONTROL, '');
  v = multiline
    ? v
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : v.replace(/\s+/g, ' ').trim();
  if (v.length < min) throw new HttpError(400, `${field} is too short`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  if (optional && v === '') return null;
  return v;
}

export function normaliseEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Please enter a valid email');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(email)) {
    throw new HttpError(400, 'Please enter a valid email');
  }
  return email;
}
