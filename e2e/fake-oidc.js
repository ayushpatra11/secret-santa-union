// A tiny fake "Google" for local development and the browser tests. It only works when
// the app runs on localhost (see devOverride in src/oauth.js).
//
//   node e2e/fake-oidc.js 8799
//
// /authorize shows a form where you type any email; /token returns an ID token for it.
// Tokens are unsigned: the app trusts the token endpoint's TLS channel instead (OIDC Core
// 3.1.3.7), and this server is only reachable on your own machine.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function startFakeOidc(port) {
  const base = `http://localhost:${port}`;
  const codes = new Map();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Fake Google</title>
        <h1>Fake Google sign-in (local only)</h1>
        <form method="post" action="/authorize">
          <label>Email <input name="email" type="email" required autofocus></label>
          ${['redirect_uri', 'state', 'nonce', 'client_id'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) || '')}">`).join('')}
          <button>Continue</button>
        </form>`);
      return;
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      const code = randomBytes(16).toString('hex');
      codes.set(code, { email: form.get('email'), nonce: form.get('nonce'), clientId: form.get('client_id') });
      const back = new URL(form.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', form.get('state'));
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!entry || form.get('client_id') !== entry.clientId || !form.get('code_verifier')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"invalid_grant"}');
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = `${b64url({ alg: 'none' })}.${b64url({
        iss: base,
        aud: entry.clientId,
        sub: entry.email,
        email: entry.email,
        email_verified: true,
        nonce: entry.nonce,
        iat: now,
        exp: now + 300,
      })}.`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8799);
  await startFakeOidc(port);
  console.log(`Fake Google sign-in on http://localhost:${port}`);
}
