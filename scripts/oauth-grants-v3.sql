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
