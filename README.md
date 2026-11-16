<p align="center">
  <img src="public/philip.svg" width="140" alt="Philip, wearing a party hat, looking hopeful">
</p>

<h1 align="center">PhilipWantedAGift.com</h1>

<p align="center"><i>Philip wanted a gift. So now everyone's getting one.</i></p>

> **This is a vibe-coded project, made for my friends.** It was built in a weekend of
> festive enthusiasm with an AI pair-programmer (Claude). It's open source, and it's
> tested and reviewed as if strangers' secrets depend on it, because they do. But it
> is a hobby project, not a company. Use it, fork it, and if you find a bug, please
> tell us (see [SECURITY.md](SECURITY.md) for anything sensitive).

A tiny, private, delightfully silly **Secret Santa** web app that runs entirely on
Cloudflare Workers + D1:

- 🔐 **Sign in with Google or Apple.** No passwords, and **no emails, ever**.
- 👤 **One profile, many Secret Santas.** Log in any year and see all your sessions.
- 🎄 **Organisers** create a session with a name, a **budget**, a date, a note and a
  **quirky group photo**, then list the people taking part and share one invite link.
- 🙋 **Friends** open the link, sign in, pick their own name and add a wishlist.
- ✨ **The draw is automatic.** The moment the last person joins, names are drawn, the
  session locks, and everyone sees who they're buying for **right in the app**.
- 🤫 **Nobody can peek.** Not other members, not the organiser, and not even whoever
  runs the website. Details below.
- 🧑‍🎄 Organisers can edit the people list, or delete the session, until it fills up.
  After that it's locked forever.

---

## How the privacy works

| Who                                  | What they can see                                                          |
| ------------------------------------ | -------------------------------------------------------------------------- |
| Other members                        | The session details and which names have joined. **Never** pairs.          |
| The organiser                        | The same, plus whether each person can open their match. **Never** pairs.  |
| You                                  | Your own match, unlocked by _your_ browser's private key.                  |
| The site operator (DB + all secrets) | Ciphertext. **Cannot** decrypt anyone's match, and has no email addresses. |

- **No email addresses are stored.** The app never sends email, so it keeps only a
  keyed fingerprint (HMAC) of the address Google or Apple verified. That's enough to
  recognise you, and lets Google and Apple logins with the same email share one account.
- **Sign-in is OpenID Connect with PKCE, `state` and `nonce`.** State is single-use,
  server-side, and bound to the browser that started the login. Only verified emails
  are accepted.
- **Session tokens and invite links are stored only as HMAC hashes.** Every sensitive
  endpoint is rate-limited.
- **Matches are sealed so only your own browser can open them.** Every browser you sign
  in on creates its own key pair. The private half is _non-extractable_ and never leaves
  the browser; the server only knows the public half. At the draw, each person's match
  is encrypted with a fresh random 256-bit key, which is locked (ECIES: P-256 ECDH +
  HKDF + AES-GCM) to each browser that person had signed in on, then thrown away. The
  database keeps only ciphertext and locked keys that the server itself can't open.
- **The draw leaks nothing.** It's not just "nobody draws themselves". Knowing who
  _you_ drew tells you nothing about who drew _you_: every other person, including your
  own giftee, is exactly equally likely (see [`src/draw.js`](src/draw.js)). Sessions need
  at least **4** people, because with 3 the maths gives everything away.
- **Group photos** are re-encoded in your browser (which strips GPS and other EXIF
  data), type-checked on the server, encrypted, and shown only to members.
- **Hardened delivery:** a strict Content-Security-Policy (no inline or third-party
  scripts), HSTS, `__Host-` cookies with `HttpOnly; Secure; SameSite=Strict`, and an
  Origin check plus a custom header on every state-changing request.

The honest limits are in [SECURITY.md](SECURITY.md#threat-model). The short version:
open your match on a browser you used **before the draw**. If you clear it (or only ever
used a private window), nobody can recover your match, and the organiser has to redraw
for everyone.

---

## Running it locally

Requirements: Node 22+.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

Put a random `APP_SECRET` in `.dev.vars`. This prints one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
npm run db:migrate:local
```

Then, in two terminals:

```bash
npm run dev:fake-google
```

```bash
npm run dev
```

Open <http://localhost:8788> and click **Continue with Google**. Locally, that goes to
a fake Google where you can type any email. The fake only works while the site runs on
localhost; production refuses it.

### Tests

```bash
npm run lint      # ESLint + Prettier
npm test          # unit + API tests against a real local D1 database
npm run test:e2e  # full browser journey with Playwright against `wrangler dev`
```

The suites cover:

- **Sign-in:** replayed callbacks, cross-browser logins, forged state, and tokens with
  the wrong nonce, audience, issuer or expiry, or an unverified email. Also open
  redirects.
- **The draw:** the full flow, plus a statistical check that it's neutral.
- **Idempotency and races:** double clicks, people racing for the last spot, repeated
  requests.
- **"Try to peek" attacks:** API responses, the database, keys, swapped ciphertexts,
  outsiders, and organiser powers.

---

## Deploying to Cloudflare (step by step)

The app is a single **Cloudflare Worker** (static files + API) connected to this GitHub
repo, so **Cloudflare builds and deploys by itself**:

- pushes to `main` → **production** at `https://philipwantedagift.com`
- other branches → **preview URLs**, shown on the pull request

GitHub Actions run all the tests on every pull request. Protect `main` (step 5) so
nothing reaches production without passing them. **No keys are needed in GitHub.**

### 1. Connect the repo (once)

1. **Workers & Pages → Create → Import a repository** → pick this repo. The Worker's
   name must match `name` in [`wrangler.toml`](wrangler.toml) (`secret-santa-union`).
2. In **Settings → Build**:
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
   - **Non-production branch deploy command:** `npx wrangler versions upload`
   - **Builds for non-production branches:** on

### 2. Create the database

1. Go to **Storage & Databases → D1 → Create database** and name it **`philipwantedagift`**.
2. Put its **Database ID** in `wrangler.toml` (`database_id`). If you fork this, use
   your own database here.
3. Create the tables. Run this once from the repo folder:

   ```bash
   npx wrangler d1 migrations apply philipwantedagift --remote
   ```

   No terminal? Paste the `CREATE` statements from
   [`migrations/0001_init.sql`](migrations/0001_init.sql) into the database's **Console**
   instead, **without the `--` comment lines**. The console joins everything into one
   line, so a comment would swallow the SQL after it. Check with `/tables`: you should
   see 9 tables.

### 3. Add the secrets

Go to **Workers & Pages → secret-santa-union → Settings → Variables and Secrets → Add**
and choose type **Secret**:

- **`APP_SECRET`:** a long random string, at least 44 random characters from a password
  manager's generator, or `openssl rand -base64 32`. **Save it somewhere safe.** If it
  changes, everyone gets a new account on their next login, and saved wishlists and
  photos become unreadable.
- **`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`:** from step 4.
- **`APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`:** optional,
  from step 4.

Each sign-in button only appears once its keys are set.

> Preview versions share production's database and secrets. That's fine for a friends'
> project, but don't share preview links around. Google/Apple sign-in always returns to
> `APP_URL` (production).

### 4. Google and Apple sign-in

**Google (free, about 10 minutes):**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. **APIs & Services → OAuth consent screen** (now called **Google Auth Platform**):
   - **Branding:** app name `PhilipWantedAGift.com`, your support email.
   - **Audience:** External, then **Publish app**. While it's in "Testing", only
     people you list as test users can sign in.
   - **Data access:** add the scopes `openid` and `.../auth/userinfo.email`.
3. **Clients → Create client → Web application**:
   - **Authorised JavaScript origins:** `https://philipwantedagift.com`
   - **Authorised redirect URIs:** `https://philipwantedagift.com/api/auth/oauth/google/callback`
4. Copy the **Client ID** and **Client secret** into the secrets `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.

**Apple** (needs a paid Apple Developer account):

1. **Certificates, IDs & Profiles → Identifiers**: create an **App ID** with _Sign in
   with Apple_ enabled, then a **Services ID**. That Services ID is `APPLE_CLIENT_ID`.
2. Configure the Services ID: domain `philipwantedagift.com`, return URL
   `https://philipwantedagift.com/api/auth/oauth/apple/callback`.
3. **Keys** → create a key with _Sign in with Apple_ and download the `.p8` file. Its
   full contents are `APPLE_PRIVATE_KEY`, its id is `APPLE_KEY_ID`, and your team id
   (top right of the developer site) is `APPLE_TEAM_ID`.

### 5. Custom domain and branch protection

- **Workers & Pages → secret-santa-union → Settings → Domains & Routes → Add → Custom
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
public/lib/        browser-side crypto (device keys, opening your sealed match)
src/               Worker entry (worker.js), API, crypto, draw, OAuth
migrations/        D1 schema
test/              unit + API + sign-in attack tests (node:test, real local D1)
e2e/               browser tests (Playwright) and the fake local Google
scripts/           e2e runner
.github/           CI and CodeQL workflows, templates
```

## Contributing

PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please read
[SECURITY.md](SECURITY.md) before touching anything near auth, crypto or the draw.

## License

[MIT](LICENSE) © Ayush Patra. Philip remains un-licensed and free-range.
