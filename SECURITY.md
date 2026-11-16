# Security

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub security advisories](https://github.com/ayushpatra11/secret-santa-union/security/advisories/new).
This is a hobby project, but reports are taken seriously and answered as quickly as possible.

Especially interesting: any way to learn who drew whom, or to sign in as someone else.

## Threat model

### Assets

1. **Pairings**: who is whose Secret Santa.
2. **Identities** of participants (we store no email addresses, only a keyed fingerprint).
3. **Accounts**: the ability to act as someone.

### What is protected, and how

| Threat                                           | Protection                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member tries to learn other pairings           | No API returns pairings. Your match is sealed with a one-time key that only your own devices' non-extractable private keys can unlock. Matches are never emailed. Tests in `test/no-peeking.test.js` try many angles.                                                                                                                                                              |
| A member infers their Santa from their own match | The draw is _neutral_: given who you drew, every other person (including them) is equally likely to be your Santa. At least 4 people are required, because with 3 the structure gives everything away.                                                                                                                                                                             |
| The organiser tries to learn pairings            | Organisers see names, joined status and whether each person can open their match. A redraw (rate-limited, for when someone lost access) produces fresh, equally sealed matches the organiser can't read either.                                                                                                                                                                    |
| Someone with a **database dump**                 | No email addresses at all (only a keyed HMAC fingerprint). Sessions and invites are HMAC-hashed. Wishlists and photos are AES-256-GCM encrypted. Matches are sealed with keys that were never stored; only device-locked copies exist.                                                                                                                                             |
| The **operator** with database + `APP_SECRET`    | **Cannot** decrypt matches, and never sees email addresses (the app doesn't send email, so it doesn't keep them).                                                                                                                                                                                                                                                                  |
| CSRF                                             | `SameSite=Strict` cookies, an `Origin` check and a required custom header on every mutation.                                                                                                                                                                                                                                                                                       |
| XSS                                              | Strict CSP (no inline scripts or styles), all user text escaped at render time, photos served with `nosniff` and a `sandbox` CSP.                                                                                                                                                                                                                                                  |
| Sign-in attacks                                  | Google / Apple only (no passwords, no codes). PKCE, `state` and `nonce`; state is single-use, server-side and bound to the browser that started the login; ID tokens are checked for issuer, audience, expiry and nonce; only verified emails are accepted; the redirect URI is fixed from `APP_URL`; the return address only accepts invite links. Tests in `test/oauth.test.js`. |
| Malicious photos                                 | Re-encoded client-side, magic-byte checked server-side (JPEG/PNG/WebP only), size-limited, encrypted, and served only to members.                                                                                                                                                                                                                                                  |

### Known limits (please read)

- **The operator runs the code.** A malicious operator could deploy modified code that
  logs the draw while it happens. That's why the project is open source and deploys
  only through public CI from `main`.
- **Your Google / Apple account is your key.** Whoever controls it can sign in as you.
- **Your match lives in your browser.** It unlocks only on the browsers you had signed
  in on _before the draw_. If you clear them, nobody can recover your match. That's the
  point. The organiser can redraw for everyone as a last resort.
- **Someone using your unlocked browser** can see your match. Lock your devices.
- **A malicious server could register a device key of its own** for a user before the
  draw. That needs modified server code (see above). It cannot be done to a draw that
  has already happened.
- **Changing `APP_SECRET` breaks existing accounts.** Everyone gets a new account on their
  next login, and saved wishlists and photos become unreadable. Treat it like a database password.

## Supported versions

Only the latest `main` is supported.
