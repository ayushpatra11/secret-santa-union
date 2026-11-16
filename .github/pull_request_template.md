## What does this change?

<!-- A short description. Link the issue if there is one. -->

## Why?

## How was it tested?

- [ ] `npm run lint`
- [ ] `npm test` (unit + API: signup, draw, idempotency, no-peeking)
- [ ] `npm run test:e2e` (browser journey)
- [ ] Checked the preview deployment

## Privacy & security checklist

- [ ] No API response, log line or database column can reveal who drew whom
- [ ] No email addresses are returned to other users, logged, or stored in plaintext
- [ ] New user input is validated server-side and escaped when rendered
- [ ] No new third-party scripts, styles or hosts (or the CSP in `public/_headers` was updated deliberately)
- [ ] Tests added for new behaviour
