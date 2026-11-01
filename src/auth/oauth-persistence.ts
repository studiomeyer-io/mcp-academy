/** DB-authoritative OAuth state. Security writes complete before returning. */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { getDb, withClient } from "../db.js";
import { hashToken } from "./token-hash.js";
import { type Grant, normalizeGrant, narrowGrant, MCP_RESOURCE } from "./grants.js";

export interface Client { client_id: string; client_name: string; redirect_uris: string[]; created_at?: Date }
export interface Authorization extends Grant {
  client_id: string; redirect_uri: string; code_challenge: string; state: string;
  browser_hash: string; csrf_hash?: string; email?: string;
}
interface TokenRow extends Grant { token: string; client_id: string; email: string; family_id: string | null; access_token?: string; expires_at: Date }
interface CodeRow extends Grant { client_id: string; email: string; redirect_uri: string; code_challenge: string; expires_at: Date }
export interface TokenPair { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number; scope: string; resource: string }
export type ExchangeResult = { ok: true; pair: TokenPair } | { ok: false; error: string };
export const randomToken = (): string => randomBytes(32).toString("base64url");

async function transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async db => {
    await db.query("BEGIN");
    try { const result = await run(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; }
  });
}
export async function saveClient(client: Client): Promise<void> {
  await transaction(async db => {
    // One database-wide lock makes the DCR cap safe across processes.
    await db.query("SELECT pg_advisory_xact_lock(88402942)");
    const count = await db.query<{ count: string }>("SELECT count(*) FROM academy_mcp_oauth_clients");
    const cap = Number(process.env.ACADEMY_MCP_MAX_OAUTH_CLIENTS ?? 10000);
    if (Number(count.rows[0]?.count) >= cap) throw new Error("client_limit_reached");
    await db.query("INSERT INTO academy_mcp_oauth_clients(client_id,client_name,redirect_uris) VALUES($1,$2,$3)", [client.client_id, client.client_name, JSON.stringify(client.redirect_uris)]);
  });
}
export async function getClient(id: string): Promise<Client | null> {
  const result = await getDb().query<Client>("SELECT client_id,client_name,redirect_uris FROM academy_mcp_oauth_clients WHERE client_id=$1", [id]);
  return result.rows[0] ?? null;
}
export async function saveAuthorization(id: string, value: Authorization, csrfHash: string): Promise<void> {
  await getDb().query(`INSERT INTO academy_mcp_oauth_authorizations(id,client_id,redirect_uri,code_challenge,state,scopes,resource,browser_hash,csrf_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+INTERVAL '10 minutes')`, [hashToken(id), value.client_id, value.redirect_uri, value.code_challenge, value.state, value.scopes, value.resource, value.browser_hash, csrfHash]);
}
export async function consumeAuthorization(id: string, browserHash: string, csrfHash: string): Promise<Authorization | null> {
  const result = await getDb().query<Authorization>(`DELETE FROM academy_mcp_oauth_authorizations WHERE id=$1 AND browser_hash=$2 AND csrf_hash=$3 AND expires_at>NOW() RETURNING *`, [hashToken(id), browserHash, csrfHash]);
  return result.rows[0] ?? null;
}
export async function saveMagicLink(token: string, value: Authorization & { email: string }): Promise<void> {
  await getDb().query(`INSERT INTO academy_mcp_oauth_magic_links(token,email,client_id,redirect_uri,state,code_challenge,scopes,resource,grant_version,consented_at,browser_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()+INTERVAL '10 minutes')`, [hashToken(token),value.email,value.client_id,value.redirect_uri,value.state,value.code_challenge,value.scopes,value.resource,value.grant_version,value.consented_at,value.browser_hash]);
}
export async function consumeMagicLink(token: string, browserHash: string): Promise<Authorization | null> {
  const result = await getDb().query<Authorization>(`DELETE FROM academy_mcp_oauth_magic_links WHERE token=$1 AND browser_hash=$2 AND expires_at>NOW() RETURNING *`, [hashToken(token),browserHash]);
  return result.rows[0] ?? null;
}
export async function saveAuthCode(value: Authorization & { email: string }): Promise<string> {
  const token = randomToken();
  await getDb().query(`INSERT INTO academy_mcp_oauth_auth_codes(code,client_id,redirect_uri,code_challenge,email,scopes,resource,grant_version,consented_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+INTERVAL '5 minutes')`, [hashToken(token),value.client_id,value.redirect_uri,value.code_challenge,value.email,value.scopes,value.resource,value.grant_version,value.consented_at]);
  return token;
}
async function familyLock(db: PoolClient, family: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [family]);
}
async function revokeFamily(db: PoolClient, family: string): Promise<void> {
  await db.query("INSERT INTO academy_mcp_oauth_revoked_families(family_id) VALUES($1) ON CONFLICT DO NOTHING", [family]);
  await db.query(`INSERT INTO academy_mcp_oauth_refresh_tombstones(token,family_id,client_id,expires_at)
    SELECT token,COALESCE(family_id,access_token),client_id,expires_at FROM academy_mcp_oauth_refresh_tokens WHERE COALESCE(family_id,access_token)=$1 ON CONFLICT DO NOTHING`, [family]);
  await db.query("DELETE FROM academy_mcp_oauth_access_tokens WHERE COALESCE(family_id,token)=$1", [family]);
  await db.query("DELETE FROM academy_mcp_oauth_refresh_tokens WHERE COALESCE(family_id,access_token)=$1", [family]);
}
async function issuePair(db: PoolClient, row: { client_id: string; email: string }, grant: Grant, family: string): Promise<TokenPair> {
  const access = randomToken(); const refresh = randomToken();
  await db.query(`INSERT INTO academy_mcp_oauth_access_tokens(token,client_id,email,family_id,scopes,resource,grant_version,consented_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+INTERVAL '1 hour')`, [hashToken(access),row.client_id,row.email,family,grant.scopes,grant.resource,grant.grant_version,grant.consented_at]);
  await db.query(`INSERT INTO academy_mcp_oauth_refresh_tokens(token,client_id,email,access_token,family_id,scopes,resource,grant_version,consented_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+INTERVAL '30 days')`, [hashToken(refresh),row.client_id,row.email,hashToken(access),family,grant.scopes,grant.resource,grant.grant_version,grant.consented_at]);
  return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:3600,scope:grant.scopes.join(" "),resource:grant.resource};
}
export async function redeemCode(form: URLSearchParams): Promise<ExchangeResult> {
  return transaction(async db => {
    const result = await db.query<CodeRow>("DELETE FROM academy_mcp_oauth_auth_codes WHERE code=$1 RETURNING *", [hashToken(form.get("code") ?? "")]);
    const row = result.rows[0];
    const verifier = form.get("code_verifier") ?? "";
    if (!row || row.expires_at.getTime() <= Date.now() || row.client_id !== form.get("client_id") || row.redirect_uri !== form.get("redirect_uri") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return {ok:false,error:"invalid_grant"};
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge.length !== row.code_challenge.length || !timingSafeEqual(Buffer.from(challenge), Buffer.from(row.code_challenge))) return {ok:false,error:"invalid_grant"};
    const grant = normalizeGrant(row);
    if (form.has("resource") && form.get("resource") !== grant.resource) return {ok:false,error:"invalid_target"};
    // The authorization-code exchange cannot expand or silently alter consent.
    if (form.has("scope") && form.get("scope") !== grant.scopes.join(" ")) return {ok:false,error:"invalid_scope"};
    const blocked = await db.query("SELECT 1 FROM academy_mcp_blocked WHERE email=$1", [row.email]);
    if (blocked.rowCount) return {ok:false,error:"access_denied"};
    return {ok:true,pair:await issuePair(db,row,grant,randomToken())};
  });
}
export async function rotateRefresh(form: URLSearchParams): Promise<ExchangeResult> {
  const hash = hashToken(form.get("refresh_token") ?? "");
  return transaction(async db => {
    // A legacy NULL family is the paired ACCESS hash, matching browser revocation.
    // Discover that stable lock key first, then re-read state UNDER that lock.
    const candidate = await db.query<{family_id:string;client_id:string}>(`SELECT COALESCE(family_id,access_token) AS family_id,client_id FROM academy_mcp_oauth_refresh_tokens WHERE token=$1
      UNION ALL SELECT family_id,client_id FROM academy_mcp_oauth_refresh_tombstones WHERE token=$1 LIMIT 1`, [hash]);
    const family = candidate.rows[0];
    if (!family || family.client_id !== form.get("client_id")) return {ok:false,error:"invalid_grant"};
    await familyLock(db,family.family_id);
    const tomb = await db.query("SELECT 1 FROM academy_mcp_oauth_refresh_tombstones WHERE token=$1", [hash]);
    if (tomb.rowCount) { await revokeFamily(db,family.family_id); return {ok:false,error:"invalid_grant"}; }
    const result = await db.query<TokenRow>("SELECT * FROM academy_mcp_oauth_refresh_tokens WHERE token=$1 FOR UPDATE", [hash]);
    const row = result.rows[0];
    const revoked = await db.query("SELECT 1 FROM academy_mcp_oauth_revoked_families WHERE family_id=$1", [family.family_id]);
    if (!row || row.expires_at.getTime() <= Date.now() || revoked.rowCount) return {ok:false,error:"invalid_grant"};
    let grant: Grant;
    try { grant = narrowGrant(normalizeGrant(row),form.get("scope"),form.get("resource")); }
    catch(error) { return {ok:false,error:error instanceof Error ? error.message : "invalid_scope"}; }
    const blocked = await db.query("SELECT 1 FROM academy_mcp_blocked WHERE email=$1", [row.email]);
    if (blocked.rowCount) { await revokeFamily(db,family.family_id); return {ok:false,error:"access_denied"}; }
    await db.query("INSERT INTO academy_mcp_oauth_refresh_tombstones(token,family_id,client_id,expires_at) VALUES($1,$2,$3,$4)", [hash,family.family_id,row.client_id,row.expires_at]);
    await db.query("DELETE FROM academy_mcp_oauth_access_tokens WHERE token=$1", [row.access_token]);
    await db.query("DELETE FROM academy_mcp_oauth_refresh_tokens WHERE token=$1", [hash]);
    return {ok:true,pair:await issuePair(db,row,grant,family.family_id)};
  });
}
export async function revokeToken(token: string, clientId: string): Promise<void> {
  await transaction(async db => {
    const hash = hashToken(token);
    const result = await db.query<{family_id:string}>(`SELECT COALESCE(family_id,token) AS family_id FROM academy_mcp_oauth_access_tokens WHERE token=$1 AND client_id=$2
      UNION ALL SELECT COALESCE(family_id,access_token) AS family_id FROM academy_mcp_oauth_refresh_tokens WHERE token=$1 AND client_id=$2
      UNION ALL SELECT family_id FROM academy_mcp_oauth_refresh_tombstones WHERE token=$1 AND client_id=$2
      UNION ALL SELECT family_id FROM academy_mcp_oauth_access_tokens WHERE family_id=$1 AND client_id=$2
      UNION ALL SELECT family_id FROM academy_mcp_oauth_refresh_tombstones WHERE family_id=$1 AND client_id=$2 LIMIT 1`, [hash,clientId]);
    const row = result.rows[0];
    if (row) { await familyLock(db,row.family_id); await revokeFamily(db,row.family_id); }
  });
}
export interface Principal extends Grant { email: string; client_id: string; accessToken: string }
export async function authenticateBearer(token: string, resource = MCP_RESOURCE): Promise<Principal | null> {
  const result = await getDb().query<TokenRow>(`SELECT a.* FROM academy_mcp_oauth_access_tokens a WHERE token=$1 AND expires_at>NOW()
    AND NOT EXISTS(SELECT 1 FROM academy_mcp_oauth_revoked_families f WHERE f.family_id=COALESCE(a.family_id,a.token))
    AND NOT EXISTS(SELECT 1 FROM academy_mcp_blocked b WHERE b.email=a.email)`, [hashToken(token)]);
  const row = result.rows[0];
  if (!row) return null;
  const grant = normalizeGrant(row);
  return grant.resource === resource ? {...grant,email:row.email,client_id:row.client_id,accessToken:token} : null;
}
export async function cleanupExpiredOAuthState(): Promise<void> {
  for (const [table,field] of [["auth_codes","expires_at"],["access_tokens","expires_at"],["refresh_tokens","expires_at"],["magic_links","expires_at"],["authorizations","expires_at"],["refresh_tombstones","expires_at"]] as const) {
    await getDb().query(`DELETE FROM academy_mcp_oauth_${table} WHERE ${field}<NOW()`);
  }
}
