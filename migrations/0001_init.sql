-- Secret Santa schema.
-- Privacy model:
--   * Sign-in is Google / Apple only and the app never sends email, so email
--     addresses are NOT stored at all: only a keyed HMAC fingerprint (email_hash),
--     so the same person gets the same account from either provider.
--   * Login tokens and invite tokens are stored only as HMAC hashes.
--   * Matches (who gifts whom) are sealed with one-time keys that only exist locked
--     to each member's own devices (see device_keys below). Nobody else, including
--     the operator with every secret, can open them. No API returns anyone else's.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email_hash   TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- A Secret Santa "exchange" (called a session in the UI).
CREATE TABLE IF NOT EXISTS exchanges (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  budget      TEXT,
  event_date  TEXT,
  message     TEXT,
  invite_hash TEXT NOT NULL UNIQUE,
  invite_enc  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  drawn_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exchanges_creator ON exchanges(creator_id);

-- One slot per invited name. A logged-in user claims a slot by joining.
CREATE TABLE IF NOT EXISTS slots (
  id           TEXT PRIMARY KEY,
  exchange_id  TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  wishlist_enc TEXT,
  giftee_enc   TEXT,
  claimed_at   INTEGER,
  UNIQUE (exchange_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_slots_exchange ON slots(exchange_id);
CREATE INDEX IF NOT EXISTS idx_slots_user ON slots(user_id);

-- Pending Google / Apple sign-ins (PKCE verifier + nonce), single use, 10 minute TTL.
-- The row is bound to a random value held in a short-lived browser cookie, so a
-- callback URL cannot be replayed or completed in somebody else's browser.
CREATE TABLE IF NOT EXISTS oauth_states (
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
CREATE TABLE IF NOT EXISTS exchange_photos (
  exchange_id TEXT PRIMARY KEY REFERENCES exchanges(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data_enc    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Portal reveal without trusting the server.
--
-- Each browser a member signs in on generates an ECDH P-256 key pair. The private
-- key is created non-extractable and stays in that browser's IndexedDB; only the
-- public key is stored here. At the draw, each giver's one-time match key is
-- wrapped (ECIES: ephemeral ECDH + HKDF-SHA256 + AES-256-GCM) to every device the
-- giver has registered. The server can wrap but never unwrap.

CREATE TABLE IF NOT EXISTS device_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id);

CREATE TABLE IF NOT EXISTS match_key_wraps (
  slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL REFERENCES device_keys(id) ON DELETE CASCADE,
  epk        TEXT NOT NULL,
  wrapped    TEXT NOT NULL,
  PRIMARY KEY (slot_id, device_id)
);
