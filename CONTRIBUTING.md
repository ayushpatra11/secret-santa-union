# Contributing

Thanks for wanting to make Philip happier! 🎁

## Ground rules

1. **Everything goes through pull requests.** Nobody pushes to `main` or `dev`
   directly. Branch from `dev`, open a PR into `dev`, and `dev` is promoted to
   `main` by PR.
2. **CI must be green**: lint, unit/API tests, browser e2e, dependency audit,
   secret scan and CodeQL.
3. **Privacy is the product.** If a change touches auth, crypto, the draw, emails or
   what an API returns, add a test to `test/no-peeking.test.js` showing it still
   can't leak a pairing or an email address.
4. **No new third-party scripts.** The CSP is strict on purpose.

## Development

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

Before pushing:

```bash
npm run check
```

That runs lint, the unit/API tests and the browser e2e test. The e2e test uses
Playwright's Chromium; install it once with `npx playwright install chromium`.

## Database changes

Add a new numbered file in `migrations/` (never edit an applied one). The maintainer
applies it to the production database (`npm run db:migrate:remote`, or paste it into the
D1 console) **before** merging the pull request that needs it.

## Commit style

Short imperative subject lines ("Add wishlist editing"), with the why in the body
when it isn't obvious.

## Code of conduct

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
