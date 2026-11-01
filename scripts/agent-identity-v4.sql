-- Additive v3 -> v4. Only MCP-owned tables; no user records or grant expansion.
CREATE TABLE IF NOT EXISTS academy_mcp_agent_registrations (
  id TEXT PRIMARY KEY,
  claim_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version IN (1,2)),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  consented_at TIMESTAMPTZ,
  claim_delivered BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK ((version=1 AND email IS NULL AND scopes='{}') OR
         (version=2 AND email IS NOT NULL AND consented_at IS NOT NULL AND scopes <@ ARRAY['learn:read','learn:write']::TEXT[]))
);
CREATE TABLE IF NOT EXISTS academy_mcp_agent_claims (
  token TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES academy_mcp_agent_registrations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  browser_hash TEXT,
  csrf_hash TEXT,
  magic_hash TEXT UNIQUE,
  verified_at TIMESTAMPTZ,
  failures INTEGER NOT NULL DEFAULT 0,
  last_poll_at TIMESTAMPTZ,
  poll_interval INTEGER NOT NULL DEFAULT 5,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS academy_mcp_agent_access_tokens (
  token TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES academy_mcp_agent_registrations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS academy_mcp_agent_access_registration_idx ON academy_mcp_agent_access_tokens(registration_id);
CREATE INDEX IF NOT EXISTS academy_mcp_agent_registration_expires_idx ON academy_mcp_agent_registrations(expires_at);
