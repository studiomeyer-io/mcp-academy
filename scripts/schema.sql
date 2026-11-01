-- SCHEMA_VERSION: 3
--
-- Tables for the hosted Academy course server (mcp.studiomeyer.academy).
--
-- These live INSIDE academy_db, next to the Academy's own Prisma tables, and
-- are prefixed academy_mcp_* so it is obvious at a glance which belongs to whom:
-- anything Prisma owns is "PascalCase" and quoted, ours is snake_case. We only
-- ever READ from Prisma's tables (User, for "is this a known address").
--
-- There is deliberately no user table here. The Academy owns identity; this
-- server proves an email address and hands it on. See src/auth/users.ts.
--
-- CREATE TABLE IF NOT EXISTS never ALTERs an existing table. That is why the
-- version guard at the bottom exists: without it a schema change reports
-- "applied" and then fails at the customer as "column does not exist".

-- ─── OAuth 2.1 + magic link ──────────────────────────────────────────
-- Every token column stores a SHA-256 HASH, never the plaintext. Lookups hash
-- the incoming value and fetch by key, which is constant-time by construction
-- and means a database dump cannot be replayed against the server.

CREATE TABLE IF NOT EXISTS academy_mcp_oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS academy_mcp_oauth_auth_codes (
  code           TEXT PRIMARY KEY,            -- HASH
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  email          TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_auth_codes_expires_idx
  ON academy_mcp_oauth_auth_codes(expires_at);

-- family_id: all tokens minted from one authorization, plus everything rotated
-- out of it, share an id. Replaying a spent refresh token revokes the whole
-- family. The reference implementation kept this in memory only, so a restart
-- turned every token into its own family and blinded the replay detector for
-- the remaining token lifetime. Persisting it costs one column.
CREATE TABLE IF NOT EXISTS academy_mcp_oauth_access_tokens (
  token       TEXT PRIMARY KEY,               -- HASH
  client_id   TEXT NOT NULL,
  email       TEXT NOT NULL,
  family_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_access_tokens_email_idx
  ON academy_mcp_oauth_access_tokens(email);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_access_tokens_expires_idx
  ON academy_mcp_oauth_access_tokens(expires_at);

CREATE TABLE IF NOT EXISTS academy_mcp_oauth_refresh_tokens (
  token         TEXT PRIMARY KEY,             -- HASH
  client_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  access_token  TEXT NOT NULL,                -- HASH of the paired access token
  family_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_refresh_tokens_expires_idx
  ON academy_mcp_oauth_refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_refresh_tokens_family_idx
  ON academy_mcp_oauth_refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS academy_mcp_oauth_magic_links (
  token          TEXT PRIMARY KEY,            -- HASH
  email          TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  state          TEXT,
  code_challenge TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_magic_links_expires_idx
  ON academy_mcp_oauth_magic_links(expires_at);

CREATE TABLE IF NOT EXISTS academy_mcp_oauth_provider_states (
  state          TEXT PRIMARY KEY,            -- a nonce, not a secret
  provider       TEXT NOT NULL CHECK (provider IN ('google', 'discord')),
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  client_state   TEXT,
  used           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_provider_states_expires_idx
  ON academy_mcp_oauth_provider_states(expires_at);

-- ─── Block list ──────────────────────────────────────────────────────
-- The reference enforces a `suspended` flag at four points in the flow. The
-- Academy's Prisma `User` has no such column and we will not migrate somebody
-- else's table for a field only this server reads - so the flag lives here.
-- Enforced at: magic-link request, magic-link redeem, social callback, and on
-- every /mcp request (a token issued before a block must stop working).
-- CHECK erzwingt Kleinschreibung: jede Pruefung normalisiert die Adresse
-- (users.ts:isUserAllowed), ein gemischt geschriebener Eintrag haette also
-- nie gegriffen - eine Sperre, die stumm nichts tut, ist schlimmer als keine.
CREATE TABLE IF NOT EXISTS academy_mcp_blocked (
  email      TEXT PRIMARY KEY CHECK (email = lower(btrim(email))),
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Schema version guard ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS academy_mcp_schema_meta (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  version     INTEGER NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Die Zeile schreibt migrate.ts, NICHT diese Datei: es muss die Version aus
-- dem Kopf hier sein, und der Vergleich davor entscheidet ueber Abbruch.
-- Eine leere Tabelle anzulegen und die Version nie einzutragen waere genau
-- die Scheinsicherheit, gegen die der Waechter gebaut ist.

-- Additive migration. Only academy_mcp_* tables are owned by this service.
DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['academy_mcp_oauth_auth_codes','academy_mcp_oauth_access_tokens','academy_mcp_oauth_refresh_tokens','academy_mcp_oauth_magic_links','academy_mcp_oauth_provider_states'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS scopes TEXT[]', target);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS resource TEXT', target);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS grant_version INTEGER', target);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ', target);
  END LOOP;
END $migration$;
ALTER TABLE academy_mcp_oauth_magic_links ADD COLUMN IF NOT EXISTS browser_hash TEXT;
ALTER TABLE academy_mcp_oauth_provider_states ADD COLUMN IF NOT EXISTS browser_hash TEXT;
CREATE TABLE IF NOT EXISTS academy_mcp_oauth_authorizations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  resource TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS academy_mcp_oauth_refresh_tombstones (
  token TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_tombstones_family_idx ON academy_mcp_oauth_refresh_tombstones(family_id);
CREATE TABLE IF NOT EXISTS academy_mcp_oauth_revoked_families (
  family_id TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS academy_mcp_oauth_access_family_idx ON academy_mcp_oauth_access_tokens(family_id);

-- Legacy NULL-family refresh rows derive their family from access_token (the paired access hash).
-- Access rows derive it from token. Keep modern family_id values unchanged; no data backfill is needed.
