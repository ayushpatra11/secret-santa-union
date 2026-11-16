-- Portal reveal without trusting the server.
--
-- Each browser a member signs in on generates an ECDH P-256 key pair. The private
-- key is created non-extractable and stays in that browser's IndexedDB; only the
-- public key is stored here. At the draw, each giver's one-time match key is
-- wrapped (ECIES: ephemeral ECDH + HKDF-SHA256 + AES-256-GCM) to every device the
-- giver has registered. The server can wrap but never unwrap.

CREATE TABLE device_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_device_keys_user ON device_keys(user_id);

CREATE TABLE match_key_wraps (
  slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL REFERENCES device_keys(id) ON DELETE CASCADE,
  epk        TEXT NOT NULL,
  wrapped    TEXT NOT NULL,
  PRIMARY KEY (slot_id, device_id)
);
