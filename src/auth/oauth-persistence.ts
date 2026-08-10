/**
 * OAuth state persistence on Postgres (academy_mcp_oauth_*).
 *
 * Fire-and-forget writes alongside in-memory Maps + boot-time rehydrate.
 * Repliziert aus ki-station src/auth/oauth-persistence.ts.
 *
 * **Token-Hashing:** Tokens (access + refresh + magic-link + auth-code) werden
 * als SHA-256-Hashes (hex) gespeichert, nie Klartext — und die in-memory Maps
 * in oauth.ts sind auf denselben Hash gekeyt. Ein eingehender Bearer wird
 * gehasht und per Hash nachgeschlagen; Klartext existiert nur im Transit.
 *
 * Daraus folgt zweierlei: ein Datenbank-Abzug laesst sich nicht gegen den
 * Server abspielen, UND rehydrierte Sitzungen funktionieren nach einem
 * Neustart weiter (es muss ja nichts entschluesselt werden). Die Referenz
 * traegt an dieser Stelle noch einen Kommentar aus der Zeit vor der
 * Hash-Umstellung, der das Gegenteil behauptet — der ist falsch und wurde
 * hier bewusst nicht uebernommen.
 */

import { getDb } from "../db.js";
import { hashToken } from "./token-hash.js";

export interface PersistedClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}

export interface PersistedAuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  email: string;
  expires_at: number;
}

export interface PersistedAccessToken {
  client_id: string;
  email: string;
  /** Shared by every token descended from one authorization — see schema.sql. */
  family_id?: string;
  created_at: number;
  expires_at: number;
}

export interface PersistedRefreshToken {
  client_id: string;
  email: string;
  access_token: string;
  family_id?: string;
  created_at: number;
  expires_at: number;
}

export interface PersistedMagicLink {
  email: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  expires_at: number;
}

function warn(label: string, err: unknown): void {
  console.error(`[academy-oauth-persist] ${label}: ${(err as Error)?.message ?? err}`);
}
function toIso(ms: number): string { return new Date(ms).toISOString(); }

export function saveClient(c: PersistedClient): void {
  const db = getDb();
  void db.query(
    `INSERT INTO academy_mcp_oauth_clients (client_id, client_name, redirect_uris, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id) DO UPDATE SET
       client_name = EXCLUDED.client_name,
       redirect_uris = EXCLUDED.redirect_uris`,
    [c.client_id, c.client_name, JSON.stringify(c.redirect_uris), toIso(c.created_at)],
  ).catch((err: unknown) => warn("saveClient", err));
}

export function saveAuthCode(code: string, v: PersistedAuthCode): void {
  const db = getDb();
  void db.query(
    `INSERT INTO academy_mcp_oauth_auth_codes (code, client_id, redirect_uri, code_challenge, email, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       redirect_uri = EXCLUDED.redirect_uri,
       code_challenge = EXCLUDED.code_challenge,
       email = EXCLUDED.email,
       expires_at = EXCLUDED.expires_at`,
    [hashToken(code), v.client_id, v.redirect_uri, v.code_challenge, v.email, toIso(v.expires_at)],
  ).catch((err: unknown) => warn("saveAuthCode", err));
}
/** Internal-cleanup variant where we already hold the hash (in-memory Map key). */
export function deleteAuthCodeByHash(hash: string): void {
  void getDb().query(`DELETE FROM academy_mcp_oauth_auth_codes WHERE code = $1`, [hash])
    .catch((err: unknown) => warn("deleteAuthCodeByHash", err));
}

export function saveAccessToken(token: string, v: PersistedAccessToken): void {
  void getDb().query(
    `INSERT INTO academy_mcp_oauth_access_tokens (token, client_id, email, family_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [hashToken(token), v.client_id, v.email, v.family_id ?? null, toIso(v.created_at), toIso(v.expires_at)],
  ).catch((err: unknown) => warn("saveAccessToken", err));
}
export function deleteAccessTokenByHash(hash: string): void {
  void getDb().query(`DELETE FROM academy_mcp_oauth_access_tokens WHERE token = $1`, [hash])
    .catch((err: unknown) => warn("deleteAccessTokenByHash", err));
}

export function saveRefreshToken(token: string, v: PersistedRefreshToken): void {
  void getDb().query(
    `INSERT INTO academy_mcp_oauth_refresh_tokens (token, client_id, email, access_token, family_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       expires_at = EXCLUDED.expires_at`,
    [hashToken(token), v.client_id, v.email, hashToken(v.access_token), v.family_id ?? null, toIso(v.created_at), toIso(v.expires_at)],
  ).catch((err: unknown) => warn("saveRefreshToken", err));
}
export function deleteRefreshTokenByHash(hash: string): void {
  void getDb().query(`DELETE FROM academy_mcp_oauth_refresh_tokens WHERE token = $1`, [hash])
    .catch((err: unknown) => warn("deleteRefreshTokenByHash", err));
}

export function saveMagicLink(token: string, v: PersistedMagicLink): void {
  void getDb().query(
    `INSERT INTO academy_mcp_oauth_magic_links (token, email, client_id, redirect_uri, state, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [hashToken(token), v.email, v.client_id, v.redirect_uri, v.state, v.code_challenge, toIso(v.expires_at)],
  ).catch((err: unknown) => warn("saveMagicLink", err));
}
export function deleteMagicLinkByHash(hash: string): void {
  void getDb().query(`DELETE FROM academy_mcp_oauth_magic_links WHERE token = $1`, [hash])
    .catch((err: unknown) => warn("deleteMagicLinkByHash", err));
}

export interface HydratedState {
  clients: Array<[string, PersistedClient]>;
  authCodes: Array<[string, PersistedAuthCode]>;
  accessTokens: Array<[string, PersistedAccessToken]>;
  refreshTokens: Array<[string, PersistedRefreshToken]>;
  magicLinks: Array<[string, PersistedMagicLink]>;
}

interface ClientRow { client_id: string; client_name: string; redirect_uris: unknown; created_at: string }
interface AuthCodeRow { code: string; client_id: string; redirect_uri: string; code_challenge: string; email: string; expires_at: string }
interface AccessTokenRow { token: string; client_id: string; email: string; family_id: string | null; created_at: string; expires_at: string }
interface RefreshTokenRow { token: string; client_id: string; email: string; access_token: string; family_id: string | null; created_at: string; expires_at: string }
interface MagicLinkRow { token: string; email: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string; expires_at: string }

export async function loadOAuthStateFromDb(): Promise<HydratedState> {
  const db = getDb();
  const out: HydratedState = {
    clients: [], authCodes: [], accessTokens: [], refreshTokens: [], magicLinks: [],
  };
  try {
    const clients = await db.query<ClientRow>(`SELECT * FROM academy_mcp_oauth_clients`);
    for (const r of clients.rows) {
      const uris = Array.isArray(r.redirect_uris) ? r.redirect_uris as string[]
        : typeof r.redirect_uris === "string" ? JSON.parse(r.redirect_uris) as string[] : [];
      out.clients.push([r.client_id, {
        client_id: r.client_id, client_name: r.client_name, redirect_uris: uris, created_at: Date.parse(r.created_at),
      }]);
    }
    const authCodes = await db.query<AuthCodeRow>(`SELECT * FROM academy_mcp_oauth_auth_codes WHERE expires_at > NOW()`);
    for (const r of authCodes.rows) {
      out.authCodes.push([r.code, {
        client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge,
        email: r.email, expires_at: Date.parse(r.expires_at),
      }]);
    }
    const accessTokens = await db.query<AccessTokenRow>(`SELECT * FROM academy_mcp_oauth_access_tokens WHERE expires_at > NOW()`);
    for (const r of accessTokens.rows) {
      out.accessTokens.push([r.token, {
        client_id: r.client_id, email: r.email, family_id: r.family_id ?? undefined,
        created_at: Date.parse(r.created_at), expires_at: Date.parse(r.expires_at),
      }]);
    }
    const refreshTokens = await db.query<RefreshTokenRow>(`SELECT * FROM academy_mcp_oauth_refresh_tokens WHERE expires_at > NOW()`);
    for (const r of refreshTokens.rows) {
      out.refreshTokens.push([r.token, {
        client_id: r.client_id, email: r.email, access_token: r.access_token,
        family_id: r.family_id ?? undefined,
        created_at: Date.parse(r.created_at), expires_at: Date.parse(r.expires_at),
      }]);
    }
    const magicLinks = await db.query<MagicLinkRow>(`SELECT * FROM academy_mcp_oauth_magic_links WHERE expires_at > NOW()`);
    for (const r of magicLinks.rows) {
      out.magicLinks.push([r.token, {
        email: r.email, client_id: r.client_id, redirect_uri: r.redirect_uri,
        state: r.state ?? "", code_challenge: r.code_challenge, expires_at: Date.parse(r.expires_at),
      }]);
    }
  } catch (err) {
    // NICHT auf EMPTY zurueckfallen (Fable-R8, Finding 7). Vorher war ein
    // gescheitertes Rehydrieren von „DB ist leer" nicht zu unterscheiden: der
    // Aufrufer loggte danach `0 clients, 0 codes, 0 tokens` — wortgleich mit
    // einem echten Frischstart. Ist die DB beim Boot kurz weg, waeren damit
    // alle bestehenden Sitzungen still tot, jeder Kunde bekaeme 401, und
    // /health meldete gruen. Ein Wurf hier bricht stattdessen den Start ab;
    // `restart: unless-stopped` versucht es erneut, sobald die DB da ist.
    warn("loadOAuthStateFromDb", err);
    throw new Error(
      `OAuth-State konnte nicht aus der DB geladen werden: ${(err as Error)?.message ?? err}`,
    );
  }
  return out;
}

export async function cleanupExpiredOAuthState(): Promise<void> {
  const db = getDb();
  await Promise.all([
    db.query(`DELETE FROM academy_mcp_oauth_auth_codes WHERE expires_at < NOW()`).catch((err: unknown) => warn("cleanup auth_codes", err)),
    db.query(`DELETE FROM academy_mcp_oauth_access_tokens WHERE expires_at < NOW()`).catch((err: unknown) => warn("cleanup access_tokens", err)),
    db.query(`DELETE FROM academy_mcp_oauth_refresh_tokens WHERE expires_at < NOW()`).catch((err: unknown) => warn("cleanup refresh_tokens", err)),
    db.query(`DELETE FROM academy_mcp_oauth_magic_links WHERE expires_at < NOW()`).catch((err: unknown) => warn("cleanup magic_links", err)),
  ]);
}
