-- Secret Santa schema.
-- Privacy model:
--   * Email addresses are NEVER stored in plaintext. We keep an HMAC "blind index"
--     (email_hash) for lookups and an AES-256-GCM ciphertext (email_enc) so the
--     server can send mail. Both keys are derived from the APP_SECRET env secret.
--   * OTP codes, login tokens and invite tokens are stored only as HMAC hashes.
--   * Assignments (who gifts whom) are encrypted and bound to the giver's slot,
--     and no API ever returns another person's assignment - not even to the creator.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email_hash   TEXT NOT NULL UNIQUE,
  email_enc    TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE otps (
  email_hash TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- A Secret Santa "exchange" (called a session in the UI).
CREATE TABLE exchanges (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  budget      TEXT,
  event_date  TEXT,
  message     TEXT,
  invite_hash TEXT NOT NULL UNIQUE,
  invite_enc  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | drawn
  created_at  INTEGER NOT NULL,
  drawn_at    INTEGER
);
CREATE INDEX idx_exchanges_creator ON exchanges(creator_id);

-- One slot per invited name. A logged-in user claims a slot by joining.
CREATE TABLE slots (
  id           TEXT PRIMARY KEY,
  exchange_id  TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  wishlist_enc TEXT,
  giftee_enc   TEXT,
  email_status TEXT NOT NULL DEFAULT 'none', -- none | pending | sent | failed
  claimed_at   INTEGER,
  UNIQUE (exchange_id, user_id)
);
CREATE INDEX idx_slots_exchange ON slots(exchange_id);
CREATE INDEX idx_slots_user ON slots(user_id);

-- Pending Google / Apple sign-ins (PKCE verifier + nonce), single use, 10 minute TTL.
-- The row is bound to a random value held in a short-lived browser cookie, so a
-- callback URL cannot be replayed or completed in somebody else's browser.
CREATE TABLE oauth_states (
  state_hash   TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  provider     TEXT NOT NULL,
  verifier     TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  return_to    TEXT,
  expires_at   INTEGER NOT NULL
);

-- Optional group photo per session. Re-encoded in the browser (strips EXIF/GPS),
-- type-checked by magic bytes on the server, stored encrypted, served only to members.
CREATE TABLE exchange_photos (
  exchange_id TEXT PRIMARY KEY REFERENCES exchanges(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data_enc    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
