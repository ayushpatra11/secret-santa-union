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
Cloudflare Pages + D1:

- 🔐 **Passwordless sign-in.** Use a 6-digit email code, or _Continue with Google / Apple_.
- 👤 **One profile, many Secret Santas.** Log in any year and see all your sessions.
- 🎄 **Organisers** create a session with a name, a **budget**, a date, a note and a
  **quirky group photo**, then list the people taking part and share one invite link.
- 🙋 **Friends** open the link, sign in, pick their own name and add a wishlist.
- ✨ **The draw is automatic.** The moment the last person joins, names are drawn,
  the session locks, and everyone can open their match **right in the app**. They also
  get an email, but the app works even if the email never arrives.
- 🤫 **Nobody can peek.** Not other members, not the organiser, and not even whoever
  runs the website. Details below.
- 🧑‍🎄 Organisers can edit the people list, or delete the session, until it fills up. After that it's locked forever.

---

## How the privacy works

| Who                                  | What they can see                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Other members                        | The session details and which names have joined. **Never** emails, never pairs. |
| The organiser                        | The same, plus whether each match email was delivered. **Never** pairs.         |
| You                                  | Your own match, unlocked by _your_ browser's private key or your email link.    |
| The site operator (DB + all secrets) | Ciphertext. **Cannot** decrypt anyone's match.                                  |

- **Emails are encrypted at rest** (AES-256-GCM). Lookups use a keyed HMAC "blind
  index", so a database dump contains no addresses.
- **Login codes, session tokens and invite links are stored only as HMAC hashes.**
  Codes expire after 10 minutes, are single-use and are attempt-limited. Every
  sensitive endpoint is rate-limited.
- **Matches are sealed so only you can open them, in the app or from your email.**
  At the draw, each person's match is encrypted with a fresh random 256-bit key, which
  is then handed out in only two ways:
  1. **To your browser.** Every browser you sign in on creates its own key pair. The
     private half is _non-extractable_ and never leaves the browser; the server only
     knows the public half. Your match key is locked (ECIES: P-256 ECDH + HKDF + AES-GCM)
     to each of your devices, so the app can show your match even if the email bounced.
  2. **In your email link**, after the `#`, so browsers never send it to any server.

  The key is then thrown away. The database keeps only ciphertext and locked keys that
  the server itself can't open.

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
the match email itself contains your giftee's name, so whoever can read your inbox,
or the email provider's logs, can see it.

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
npm run test:e2e  # full browser journey with Playwright against `wrangler pages dev`
```

The suites cover signup and login, the full draw, idempotency and races (double
clicks, people racing for the last spot, repeated requests), and a long list of
"try to peek" attacks: API responses, the database, keys, swapped ciphertexts,
outsiders, and organiser powers.

---

## Deploying to Cloudflare (step by step)

Everything deploys from GitHub Actions, **only after all tests pass**:

- every pull request → a **preview** at `https://preview.philipwantedagift.pages.dev`, which is
  smoke-tested once it's live
- every merge to `main` → **production** at `https://philipwantedagift.com`

### 1. Create the Cloudflare resources (once)

```bash
npx wrangler login
```

```bash
npx wrangler pages project create philipwantedagift --production-branch main
```

```bash
npx wrangler d1 create philipwantedagift
```

```bash
npx wrangler d1 create philipwantedagift-preview
```

Paste the two `database_id`s into `wrangler.toml` (`env.production` and `env.preview`).
Then attach your domain: **Workers & Pages → philipwantedagift → Custom domains →
`philipwantedagift.com`**.

> Use a **Direct Upload** Pages project (as created above). Don't connect Cloudflare's
> own Git integration, or it would deploy without waiting for the tests.

### 2. Set the secrets (once per environment)

Secrets never go in git. Set each one for **production** and again with `--env preview`:

```bash
npx wrangler pages secret put APP_SECRET --project-name philipwantedagift
```

```bash
npx wrangler pages secret put APP_SECRET --project-name philipwantedagift --env preview
```

| Secret                                                                  | What it is                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                                                            | 32 random bytes, base64 (`openssl rand -base64 32`). Master key for encryption and hashing. **Back it up in a password manager. If you lose or change it, every stored email becomes unreadable.** Use a different value for preview. |
| `EMAIL_API_KEY`                                                         | Your Brevo or Resend API key (see below).                                                                                                                                                                                             |
| `EMAIL_FROM`                                                            | The verified sender, e.g. `santa@philipwantedagift.com`.                                                                                                                                                                              |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                              | Optional: enables "Continue with Google".                                                                                                                                                                                             |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Optional: enables "Continue with Apple".                                                                                                                                                                                              |
| `TURNSTILE_SECRET_KEY`                                                  | Optional: bot protection on the email-code form (also add `TURNSTILE_SITE_KEY` under `vars` in `wrangler.toml`).                                                                                                                      |

### 3. Set up email

Cloudflare Workers can't speak SMTP easily, so the app uses an email **HTTP API**.
Pick one; both have free tiers that are plenty for a group of friends:

**Option A: Brevo (recommended, works with or without a domain)**

1. Sign up at brevo.com and go to **SMTP & API → API keys**. Create a key and use it as `EMAIL_API_KEY`.
2. **Senders, domains & dedicated IPs → Domains → Add a domain** → `philipwantedagift.com`.
   Brevo shows DKIM, SPF and DMARC records. Add them in **Cloudflare DNS**: the domain
   is already on Cloudflare, so this takes two minutes.
3. Add a sender, e.g. `santa@philipwantedagift.com`, and use it as `EMAIL_FROM`.
4. Keep `EMAIL_PROVIDER = "brevo"` in `wrangler.toml`.

**Option B: Resend.** Verify the domain the same way, set `EMAIL_PROVIDER = "resend"`,
and use the Resend API key.

**Do you need a throwaway Gmail?** Not if you own `philipwantedagift.com`: a sender on
your own domain with DKIM/SPF has much better deliverability, and no inbox is needed
because the app never receives mail. A throwaway Gmail is only useful **without a
domain**: Brevo lets you verify a single sender address. Expect more emails to land in
spam that way.

**Optional extra privacy:** in your provider's settings, turn off or shorten the
retention of email _content_ logs where possible, and don't browse them. They can
contain match emails.

### 4. Optional: "Continue with Google"

1. Google Cloud Console → **APIs & Services → OAuth consent screen** → External. Use the
   scopes `openid` and `email`.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorised redirect URIs:
   - `https://philipwantedagift.com/api/auth/oauth/google/callback`
   - `https://preview.philipwantedagift.pages.dev/api/auth/oauth/google/callback`
4. Save the client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 5. Optional: "Continue with Apple"

This needs a paid Apple Developer account.

1. **Certificates, IDs & Profiles → Identifiers**: create an App ID with _Sign in with
   Apple_, then a **Services ID**. That Services ID is `APPLE_CLIENT_ID`.
2. Configure the Services ID: domain `philipwantedagift.com`, return URL
   `https://philipwantedagift.com/api/auth/oauth/apple/callback`.
3. **Keys** → create a key with _Sign in with Apple_ and download the `.p8`. Its
   contents are `APPLE_PRIVATE_KEY`, its id is `APPLE_KEY_ID`, and your team id is `APPLE_TEAM_ID`.
4. **Important:** people who choose _Hide My Email_ get an `@privaterelay.appleid.com`
   address. Register your sending domain/address under **Services → Sign in with Apple
   for Email Communication**, or Apple will silently drop your emails.

### 6. Connect GitHub Actions

In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add:

- `CLOUDFLARE_API_TOKEN`: a token with **Account → Cloudflare Pages: Edit** and
  **Account → D1: Edit** (nothing else).
- `CLOUDFLARE_ACCOUNT_ID`

Then go to **Settings → Environments** and create `preview` and `production`. For
`production`, limit deployment branches to `main`. You can also require your own approval before each deploy.

### 7. Protect the branches

**Settings → Rules → Rulesets**, for `main` **and** `dev`:

- Require a pull request before merging, with code-owner review.
- Require these status checks to pass: _Lint & format_, _Unit & API tests_,
  _Browser end-to-end_, _Dependency audit & secret scan_, _Analyze JavaScript_.
- Block force pushes and deletions.

The flow is: feature branch → PR into `dev` → PR from `dev` into `main` → production.

---

## Project layout

```
public/            static site (index.html, app.js, styles.css, _headers = security headers)
public/lib/        browser-side crypto (opening your sealed match)
functions/api/     Cloudflare Pages Function entry point (routes /api/*)
src/               API, crypto, draw, email, OAuth
migrations/        D1 schema
test/              unit + API tests (node:test, real local D1)
e2e/               browser tests (Playwright)
scripts/           e2e runner, post-deploy smoke test
.github/           CI, CodeQL, deploy workflows, templates
```

## Contributing

PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please read
[SECURITY.md](SECURITY.md) before touching anything near auth, crypto or the draw.

## License

[MIT](LICENSE) © Ayush Patra. Philip remains un-licensed and free-range.
