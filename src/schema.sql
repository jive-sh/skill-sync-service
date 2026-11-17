-- One row per file ever seen, including deleted ones.
--
-- A deleted file keeps its row with hash NULL rather than being removed: without that tombstone, a skill
-- you delete on one machine is simply absent from the index, and the next machine to sync sees no reason
-- not to upload it again.
--
-- `seq` is a monotonic counter, not a timestamp. Clients poll with the highest seq they have applied, and
-- two machines writing in the same millisecond would otherwise let one of them be skipped forever.
--
-- `edited_at` is when the version held was edited on the machine that sent it, and decides every
-- disagreement: a write lands only if it was edited later. `updated_at` is when the server received it.
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  hash       TEXT,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  edited_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS files_by_seq ON files(seq);

-- The passkeys allowed to sign in. Registration is open only while this table is empty, so the first
-- visit to /register claims the service and every later one is refused — no bootstrap secret to store,
-- and nothing to remember to switch off.
CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Short-lived WebAuthn challenges. A challenge is single-use: it is deleted when consumed, so a captured
-- one cannot be replayed.
CREATE TABLE IF NOT EXISTS challenges (
  challenge  TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- One row per machine that has signed in. The token itself is never stored — only its SHA-256 — so a
-- dump of this table cannot be replayed against the service.
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY,
  machine    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

-- Every skills folder each machine reports, and whether it syncs. The daemon is the source of truth: a
-- folder it stops reporting is deleted, with its skills. A new folder starts disabled until ticked.
-- `state`, `detail` and the activity columns are what the dashboard shows; the daemon reports them only
-- when they change, so they cost writes per change, not per poll.
CREATE TABLE IF NOT EXISTS folders (
  machine          TEXT NOT NULL,
  path             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0,
  detected_at      INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'idle',
  detail           TEXT,
  last_activity_at INTEGER,
  last_activity    TEXT,
  PRIMARY KEY (machine, path)
);

-- Browser sessions for the dashboard, from the same passkey ceremony as a machine token. Only the hash
-- is stored, as with device tokens.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The skills that sync: one list for every machine and folder. Every enabled folder pushes and pulls
-- exactly these, and never touches any other skill. Ticking a skill on the dashboard adds it here;
-- unticking removes it, and every copy stays where it is. A skill whose last file is deleted gets
-- `deleted_at`: it leaves the list shown, but daemons keep syncing it so each deletes its own copy.
CREATE TABLE IF NOT EXISTS synced_skills (
  skill      TEXT PRIMARY KEY,
  added_at   INTEGER NOT NULL,
  deleted_at INTEGER
);

-- The skills each folder has on disk, as its daemon last reported them, for the dashboard. `files` is the
-- folder's file list for the skill, as JSON. Nothing here decides what syncs.
CREATE TABLE IF NOT EXISTS skills (
  machine TEXT NOT NULL,
  folder  TEXT NOT NULL,
  skill   TEXT NOT NULL,
  files   TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (machine, folder, skill)
);

-- Dashboard display names. A machine keeps the name its daemon uses as its identity everywhere else;
-- only what the dashboard shows changes, so renaming touches no other table and no machine's config.
CREATE TABLE IF NOT EXISTS machines (
  machine TEXT PRIMARY KEY,
  name    TEXT NOT NULL
);

-- Each machine's latest usage reading of each account folder it has (`~/.claude-work`, `~/.codex`), as its
-- daemon last sent it, so an offline machine's last values still show. `usage` is the reading as JSON,
-- checked by `accountsFrom` before it is written. A daemon sends every account on its machine at once, so
-- a folder it stops sending is deleted.
CREATE TABLE IF NOT EXISTS account_readings (
  machine     TEXT NOT NULL,
  home        TEXT NOT NULL,
  usage       TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (machine, home)
);
