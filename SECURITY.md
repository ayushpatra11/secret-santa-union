# Security

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub security advisories](https://github.com/ayushpatra11/secret-santa-union/security/advisories/new).
This is a hobby project, but reports are taken seriously and answered as quickly as possible.

Especially interesting: any way to learn who drew whom, to read someone's email
address, or to sign in as someone else.

## Threat model

### Assets

1. **Pairings**: who is whose Secret Santa.
2. **Email addresses** of participants.
3. **Accounts**: the ability to act as someone.

### What is protected, and how

| Threat                                           | Protection                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member tries to learn other pairings           | No API returns pairings. Your match is sealed with a key only you received. Tests in `test/no-peeking.test.js` try many angles.                                                                                     |
| A member infers their Santa from their own match | The draw is _neutral_: given who you drew, every other person (including them) is equally likely to be your Santa. At least 4 people are required, because with 3 the structure gives everything away.              |
| The organiser tries to learn pairings            | Organisers see names, joined status and email delivery status only. They can't redraw once every email was delivered, and a redraw (only possible after a delivery failure) produces fresh, equally sealed matches. |
| Someone with a **database dump**                 | Emails are AES-256-GCM encrypted. Codes, sessions and invites are HMAC-hashed. Matches are sealed with keys that were never stored.                                                                                 |
| The **operator** with database + `APP_SECRET`    | Can decrypt email addresses (needed to send mail) but **cannot** decrypt matches.                                                                                                                                   |
| Guessing login codes                             | 6 digits, 10-minute expiry, 5 attempts per code, plus per-email and per-IP rate limits.                                                                                                                             |
| Account enumeration                              | "Send code" responds identically whether or not an account exists.                                                                                                                                                  |
| CSRF                                             | `SameSite=Strict` cookies, an `Origin` check and a required custom header on every mutation.                                                                                                                        |
| XSS                                              | Strict CSP (no inline scripts or styles), all user text escaped at render time, photos served with `nosniff` and a `sandbox` CSP.                                                                                   |
| OAuth attacks                                    | PKCE, `state` and `nonce`. State is single-use, server-side and bound to the browser that started the login. Only verified emails are accepted, and the redirect URI is fixed from `APP_URL`.                       |
| Malicious photos                                 | Re-encoded client-side, magic-byte checked server-side (JPEG/PNG/WebP only), size-limited, encrypted, and served only to members.                                                                                   |

### Known limits (please read)

- **The match email contains the giftee's name.** Anyone who can read the recipient's
  inbox can see it. So can the email provider, which may keep message content in its
  logs, and therefore anyone with access to the operator's email-provider account.
  Reduce content-log retention where your provider allows it.
- **The operator runs the code.** A malicious operator could deploy modified code that
  logs the draw while it happens. That's why the project is open source and deploys
  only through public CI from `main`.
- **Email-code login trusts the inbox.** Whoever controls your inbox can sign in as you.
  The same is true of the operator's email-provider logs, which show login codes too.
- **Lost match email.** Your match key exists only in that email (and in the browser
  where you opened it). If you delete the email and use a new device, nobody can
  recover your match. That's the point.
- **Changing `APP_SECRET` makes stored emails unreadable.** Treat it like a database password.

## Supported versions

Only the latest `main` is supported.
