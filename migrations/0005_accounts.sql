-- FeedbackKit schema v5 (Gate 2): local accounts, passkeys, sessions, one-time
-- links and scoped API tokens. Expand-only: new tables and one index, no change
-- to an existing table, so the previous release keeps its six-column inserts.
-- A release that does not know these tables would honor ADMIN_TOKEN again once
-- the first owner exists, so this schema comes with DELIVERY_CAPABILITY 4 and a
-- release below 4 refuses to start on it (docs/design/gate2-accounts.md).
--
-- No foreign keys: D1 and SQLite handle them differently, and every write that
-- spans tables runs as one batch with guards that name the rows it needs
-- (docs/design/gate2-accounts.md, "The atomic owner claim on both runtimes").

-- A person who may sign in. `removed` keeps the row so that history stays
-- readable; the name is free again (partial unique index below).
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,                                  -- lower-cased name, unique among live accounts
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  state      TEXT NOT NULL CHECK (state IN ('invited', 'active', 'removed')),
  created_at INTEGER NOT NULL,
  created_by TEXT,                                           -- account id, or 'host' for a command run on the host
  last_seen_at INTEGER,
  removed_at INTEGER
);
CREATE UNIQUE INDEX idx_accounts_name_live ON accounts (name_key) WHERE state != 'removed';

-- The arbiter of "exactly one first owner". The row is written by the batch that
-- creates the first owner and by nothing else. Its primary key is what makes a
-- second concurrent attempt fail, on SQLite and on D1 alike.
CREATE TABLE owner_claim (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  account_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,                             -- credential ID, base64url
  account_id   TEXT NOT NULL,
  public_key   TEXT NOT NULL,                                -- COSE public key, base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                                         -- JSON array, as reported at enrollment
  device_type  TEXT,                                         -- singleDevice | multiDevice
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkeys_account ON passkeys (account_id);

-- `id` is the SHA-256 of the session token. The token itself is never stored, so
-- a copy of the database cannot be used to sign in. `public_id` names the
-- session in the account page without revealing the hash.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,
  account_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_account ON sessions (account_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- One-time links for the first owner, for recovery and for invitations. `id` is
-- the SHA-256 of the token (the token goes into a URL fragment and is never
-- stored). `used_by` carries the random stamp of the attempt that won the link.
CREATE TABLE setup_links (
  id         TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('bootstrap', 'recovery', 'invite')),
  account_id TEXT,                                           -- recovery and invite; NULL for bootstrap
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_by TEXT,
  keep_tokens INTEGER NOT NULL DEFAULT 0,                    -- recovery only: 1 keeps the account's API tokens (the default revokes them)
  used_at    INTEGER,
  used_by    TEXT
);
CREATE INDEX idx_setup_links_account ON setup_links (account_id);

-- Challenges are signed, not stored. This table only remembers which ones were
-- redeemed, so a captured response cannot be played again before it expires.
CREATE TABLE used_challenges (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Scoped API tokens for scripts and agents. `token_hash` is the SHA-256 of the
-- token (256 random bits, so no slow hash is needed). The token is shown once.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,                                -- first characters, to tell tokens apart in the list
  name         TEXT NOT NULL,
  account_id   TEXT NOT NULL,                                -- the owner who created it
  access       TEXT NOT NULL CHECK (access IN ('read', 'write')),
  projects     TEXT,                                         -- JSON array of project IDs; NULL means every project
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_api_tokens_account ON api_tokens (account_id);

UPDATE meta SET value = '5' WHERE key = 'schema_version';
