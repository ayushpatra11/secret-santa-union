<p align="center">
  <img src="public/philip.svg" width="140" alt="Philip, wearing a party hat, looking hopeful">
</p>

<h1 align="center">PhilipWantedAGift.com</h1>

<p align="center"><i>Philip wanted a gift. So now everyone's getting one.</i></p>

> **This is a vibe-coded project, made for my friends.** It was built in a weekend of
> festive enthusiasm with an AI pair-programmer (Claude). It's open source, and
> it's tested and reviewed as if strangers' secrets depend on it, because they do. But it is a hobby
> project, not a company. Use it, fork it, and if you find a bug, please tell us
> (see [SECURITY.md](SECURITY.md) for anything sensitive).

A tiny, private, delightfully silly **Secret Santa** web app that runs entirely on
Cloudflare Workers + D1:

- 🔐 **Passwordless sign-in.** Use a 6-digit email code, or _Continue with Google / Apple_.
- 👤 **One profile, many Secret Santas.** Log in any year and see all your sessions.
- 🎄 **Organisers** create a session with a name, a **budget**, a date, a note and a
  **quirky group photo**, then list the people taking part and share one invite link.
- 🙋 **Friends** open the link, sign in, pick their own name and add a wishlist.
- ✨ **The draw is automatic.** The moment the last person joins, names are drawn,
  the session locks, and everyone opens their match **right in the app**. No match
  emails are ever sent: email is only used for login codes.
- 🤫 **Nobody can peek.** Not other members, not the organiser, and not even whoever
  runs the website. Details below.
- 🧑‍🎄 Organisers can edit the people list, or delete the session, until it fills up. After that it's locked forever.

---

## How the privacy works

| Who                                  | What they can see                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Other members                        | The session details and which names have joined. **Never** emails, never pairs. |
| The organiser                        | The same, plus whether each person can open their match. **Never** pairs.       |
| You                                  | Your own match, unlocked by _your_ browser's private key.                       |
| The site operator (DB + all secrets) | Ciphertext. **Cannot** decrypt anyone's match.                                  |

- **Emails are encrypted at rest** (AES-256-GCM). Lookups use a keyed HMAC "blind
  index", so a database dump contains no addresses.
- **Login codes, session tokens and invite links are stored only as HMAC hashes.**
  Codes expire after 10 minutes, are single-use and are attempt-limited. Every
  sensitive endpoint is rate-limited.
- **Matches are sealed so only your own browser can open them.** Every browser you sign
  in on creates its own key pair. The private half is _non-extractable_ and never leaves
  the browser; the server only knows the public half. At the draw, each person's match
  is encrypted with a fresh random 256-bit key, which is locked (ECIES: P-256 ECDH +
  HKDF + AES-GCM) to each browser that person had signed in on, then thrown away. The
  database keeps only ciphertext and locked keys that the server itself can't open.
  No match is ever emailed, logged or shown to anyone else.

- **The draw leaks nothing.** It's not just "nobody draws themselves". Knowing who
  _you_ drew tells you nothing about who drew _you_: every other person, including
  your own giftee, is exactly equally likely (see [`src/draw.js`](src/draw.js)).
  Sessions need at least **4** people, because with 3 the maths gives everything away.
- **Group photos** are re-encoded in your browser (which strips GPS and other EXIF
  data), type-checked on the server, encrypted, and shown only to members.
- Hardened delivery: strict Content-Security-Policy (no inline scripts, no third-party
  JS except optional Cloudflare Turnstile), HSTS, `__Host-` cookies with
  `HttpOnly; Secure; SameSite=Strict`, and an Origin check plus a custom header on
  every state-changing request.

The honest limits are in [SECURITY.md](SECURITY.md#threat-model). The short version:
open your match on a browser you used **before the draw**. If you clear it (or only
ever used a private window), nobody can recover your match, and the organiser has to
redraw for everyone.

---

## Running it locally

Requirements: Node 22+.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

Then put a random secret in `.dev.vars`:

```bash
node -e "console.log('APP_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

Open <http://localhost:8788>. Locally, emails (login codes and match links) are
**printed in the terminal** instead of being sent.

### Tests

```bash
npm run lint      # ESLint + Prettier
npm test          # unit + API tests against a real local D1 database
npm run test:e2e  # full browser journey with Playwright against `wrangler dev`
```

The suites cover signup and login, the full draw, idempotency and races (double
clicks, people racing for the last spot, repeated requests), and a long list of
"try to peek" attacks: API responses, the database, keys, swapped ciphertexts,
outsiders, and organiser powers.

---

## Deploying to Cloudflare (step by step)

The app is a single **Cloudflare Worker** (static files + API) connected to this GitHub
repo, so **Cloudflare builds and deploys by itself**:

- pushes to `main` → **production** at `https://philipwantedagift.com`
- other branches → **preview URLs**, shown on the pull request

GitHub Actions run all the tests on every pull request. Protect `main` (step 6) so
nothing reaches production without passing them. **No keys are needed in GitHub.**

### 1. Connect the repo (once)

1. **Workers & Pages → Create → Import a repository** → pick this repo. Name it
   `philipwantedagift`.
2. In **Settings → Build**:
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
   - **Non-production branch deploy command:** `npx wrangler versions upload`
   - **Builds for non-production branches:** on

### 2. Create the database

1. Go to **Storage & Databases → D1 → Create database** and name it **`philipwantedagift`**.
2. Copy its **Database ID** into `wrangler.toml`, replacing `REPLACE_WITH_DATABASE_ID`.
3. Open the database → **Console**, paste the whole of
   [`migrations/0001_init.sql`](migrations/0001_init.sql), and click **Execute**. This
   creates the tables. Do it once; future migrations are applied the same way.

### 3. Add the secrets

Go to **Workers & Pages → philipwantedagift → Settings → Variables and Secrets → Add**
and choose type **Secret**:

| Name            | Value                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`    | A long random string: at least 44 random characters from a password manager's generator, or `openssl rand -base64 32`. **Save it somewhere safe.** Losing or changing it makes stored emails unreadable. |
| `EMAIL_API_KEY` | Your Brevo API key (step 4).                                                                                                                                                                             |
| `EMAIL_FROM`    | `santa@philipwantedagift.com`                                                                                                                                                                            |

Optional: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, the Apple keys (step 5), and
`TURNSTILE_SECRET_KEY` (bot protection).

> Preview versions share production's database and secrets. That's fine for a friends'
> project, but don't share preview links around.

### 4. Email for login codes (Brevo, free)

Email is only used to send 6-digit login codes. Matches are never emailed.

1. Sign up at brevo.com.
2. **Senders, domains & dedicated IPs → Domains → Add a domain** → `philipwantedagift.com`.
   Add the DNS records Brevo shows in **Cloudflare → philipwantedagift.com → DNS**.
3. **Senders → Add a sender** → `santa@philipwantedagift.com`. No real inbox is needed.
4. **SMTP & API → API keys → Generate** and use the key as `EMAIL_API_KEY`.

You don't need a throwaway Gmail: a sender on your own domain delivers better.
(Resend works too: set `EMAIL_PROVIDER = "resend"` in `wrangler.toml`.)

### 5. Optional: Google and Apple sign-in

**Google:**

1. In Google Cloud Console, go to **APIs & Services → OAuth consent screen**. Choose
   External, with the scopes `openid` and `email`.
2. **Credentials → OAuth client ID → Web application**.
3. Add the redirect URI `https://philipwantedagift.com/api/auth/oauth/google/callback`.
4. Add the client ID and secret as the secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Apple** needs a paid Apple Developer account:

1. Create a **Services ID** with _Sign in with Apple_, using the domain
   `philipwantedagift.com` and the return URL
   `https://philipwantedagift.com/api/auth/oauth/apple/callback`. This Services ID is `APPLE_CLIENT_ID`.
2. Create a **Key** with _Sign in with Apple_. Its `.p8` contents are `APPLE_PRIVATE_KEY`,
   its id is `APPLE_KEY_ID`, and your team id is `APPLE_TEAM_ID`.
3. Under **Sign in with Apple for Email Communication**, register
   `santa@philipwantedagift.com`, or login codes to "Hide My Email" addresses are dropped.

### 6. Custom domain and branch protection

- **Workers & Pages → philipwantedagift → Settings → Domains & Routes → Add → Custom
  domain** → `philipwantedagift.com`. On the same page, turn **Preview URLs** on.
- In GitHub, go to **Settings → Rules → Rulesets → New branch ruleset** for `main`:
  - require a pull request
  - require the status checks _Lint & format_, _Unit & API tests_, _Browser end-to-end_,
    _Dependency audit & secret scan_ and _Analyze JavaScript_
  - block force pushes

---

## Project layout

```
public/            static site (index.html, app.js, styles.css, _headers = security headers)
public/lib/        browser-side crypto (opening your sealed match)
src/               Worker entry (worker.js), API, crypto, draw, email, OAuth
migrations/        D1 schema
test/              unit + API tests (node:test, real local D1)
e2e/               browser tests (Playwright)
scripts/           e2e runner
.github/           CI and CodeQL workflows, templates
```

## Contributing

PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please read
[SECURITY.md](SECURITY.md) before touching anything near auth, crypto or the draw.

## License

[MIT](LICENSE) © Ayush Patra. Philip remains un-licensed and free-range.
