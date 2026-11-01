/** Durable anonymous identities and human claim state. No anonymous row is a user. */
import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { getDb,withClient } from "../db.js";
import { randomToken } from "./oauth-persistence.js";
import { hashToken } from "./token-hash.js";
import { MCP_RESOURCE,type Scope } from "./grants.js";
import { signAgentAssertion,verifyAgentAssertion } from "./agent-assertions.js";
import { getBaseUrl } from "../core/base-url.js";
export class AgentIdentityError extends Error {
  constructor(readonly code:string,readonly status=400){super(code);}
}
interface Registration {id:string;claim_hash:string;email:string|null;version:number;scopes:Scope[];consented_at:Date|null;claim_delivered:boolean;expires_at:Date;}
export interface Claim {token:string;registration_id:string;email:string;code_hash:string;browser_hash:string|null;csrf_hash:string|null;magic_hash:string|null;verified_at:Date|null;failures:number;last_poll_at:Date|null;poll_interval:number;expires_at:Date;}
const alive=(date:Date)=>date.getTime()>Date.now();
async function transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T> {
  return withClient(async db=>{await db.query("BEGIN");try{const result=await fn(db);await db.query("COMMIT");return result;}catch(error){await db.query("ROLLBACK");throw error;}});
}
async function unblocked(db:PoolClient,email:string):Promise<boolean> {return !(await db.query("SELECT 1 FROM academy_mcp_blocked WHERE email=$1",[email])).rowCount;}
async function liveFamily(db:PoolClient,id:string):Promise<boolean> {return !(await db.query("SELECT 1 FROM academy_mcp_oauth_revoked_families WHERE family_id=$1",[`agent:${id}`])).rowCount;}
async function mintAccess(db:PoolClient,r:Registration,scopes:Scope[]) {
  const raw=randomToken(),expires=new Date(Math.min(Date.now()+3600000,r.expires_at.getTime()));
  if(r.email)await db.query(`INSERT INTO academy_mcp_oauth_access_tokens(token,client_id,email,family_id,scopes,resource,grant_version,consented_at,expires_at)
    VALUES($1,$2,$3,$2,$4,$5,2,$6,$7)`,[hashToken(raw),`agent:${r.id}`,r.email,scopes,MCP_RESOURCE,r.consented_at,expires]);
  await db.query("INSERT INTO academy_mcp_agent_access_tokens(token,registration_id,version,expires_at) VALUES($1,$2,$3,$4)",[hashToken(raw),r.id,r.version,expires]);
  return {access_token:raw,token_type:"Bearer",expires_in:Math.max(0,Math.floor((expires.getTime()-Date.now())/1000)),scope:scopes.join(" "),resource:MCP_RESOURCE};
}
export async function registerAnonymousAgent() {
  return transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(88402944)");
    const count=await db.query<{count:string}>("SELECT count(*) FROM academy_mcp_agent_registrations WHERE expires_at>NOW()");
    if(Number(count.rows[0].count)>=10000)throw new AgentIdentityError("rate_limited",429);
    const id=`reg_${randomToken()}`,claim=`clm_${randomToken()}`,expires=new Date(Date.now()+86400000);
    await db.query("INSERT INTO academy_mcp_agent_registrations(id,claim_hash,expires_at) VALUES($1,$2,$3)",[id,hashToken(claim),expires]);
    return {registration_id:id,registration_type:"anonymous",...signAgentAssertion(id,1,expires),pre_claim_scopes:[],claim_url:`${getBaseUrl()}/agent/identity/claim`,claim_token:claim,claim_token_expires:expires.toISOString(),post_claim_scopes:["learn:read","learn:write"]};
  });
}
export async function beginAgentClaim(claimToken:string,email:string) {
  return transaction(async db=>{
    const r=(await db.query<Registration>("SELECT * FROM academy_mcp_agent_registrations WHERE claim_hash=$1 FOR UPDATE",[hashToken(claimToken)])).rows[0];
    if(!r)throw new AgentIdentityError("invalid_claim_token");
    if(!alive(r.expires_at))throw new AgentIdentityError("claim_expired",410);
    if(r.version!==1)throw new AgentIdentityError("claimed_or_in_flight",409);
    const old=(await db.query<Claim>("SELECT * FROM academy_mcp_agent_claims WHERE registration_id=$1",[r.id])).rows[0];
    if(old && (old.email!==email || alive(old.expires_at)))throw new AgentIdentityError("claimed_or_in_flight",409);
    if(old)await db.query("DELETE FROM academy_mcp_agent_claims WHERE registration_id=$1",[r.id]);
    const token=randomToken(),code=String(randomInt(1000000)).padStart(6,"0"),expires=new Date(Math.min(Date.now()+600000,r.expires_at.getTime()));
    await db.query("INSERT INTO academy_mcp_agent_claims(token,registration_id,email,code_hash,expires_at) VALUES($1,$2,$3,$4,$5)",[hashToken(token),r.id,email,hashToken(`${r.id}:${code}`),expires]);
    return {registration_id:r.id,claim_attempt_id:`cla_${randomToken()}`,status:"initiated",expires_at:expires.toISOString(),claim_attempt:{user_code:code,expires_in:Math.floor((expires.getTime()-Date.now())/1000),verification_uri:`${getBaseUrl()}/agent/identity/claim/verify?claim_attempt_token=${token}`,interval:5}};
  });
}
export async function bindClaimBrowser(token:string,browser:string,csrf:string):Promise<Claim|null> {
  return transaction(async db=>{
    const c=(await db.query<Claim>("SELECT * FROM academy_mcp_agent_claims WHERE token=$1 FOR UPDATE",[hashToken(token)])).rows[0];
    if(!c || !alive(c.expires_at)||c.failures>=5 || (c.browser_hash && c.browser_hash!==hashToken(browser)))return null;
    return (await db.query<Claim>("UPDATE academy_mcp_agent_claims SET browser_hash=$2,csrf_hash=$3 WHERE token=$1 RETURNING *",[c.token,hashToken(browser),hashToken(csrf)])).rows[0];
  });
}
export async function prepareClaimMagic(token:string,browser:string,csrf:string,email:string):Promise<string|null> {
  const raw=randomToken();
  const updated=await getDb().query(`UPDATE academy_mcp_agent_claims SET magic_hash=$5,verified_at=NULL WHERE token=$1 AND browser_hash=$2 AND csrf_hash=$3 AND email=$4 AND expires_at>NOW() AND failures<5 RETURNING token`,[hashToken(token),hashToken(browser),hashToken(csrf),email,hashToken(raw)]);
  return updated.rowCount?raw:null;
}
export async function verifyClaimMagic(raw:string,browser:string):Promise<Claim|null> {
  return (await getDb().query<Claim>("UPDATE academy_mcp_agent_claims SET verified_at=NOW(),magic_hash=NULL WHERE magic_hash=$1 AND browser_hash=$2 AND expires_at>NOW() AND failures<5 RETURNING *",[hashToken(raw),hashToken(browser)])).rows[0]??null;
}
export async function approveAgentClaim(token:string,browser:string,csrf:string,code:string,scopes:Scope[]):Promise<boolean> {
  return transaction(async db=>{
    const r=(await db.query<Registration>("SELECT * FROM academy_mcp_agent_registrations WHERE id=(SELECT registration_id FROM academy_mcp_agent_claims WHERE token=$1) FOR UPDATE",[hashToken(token)])).rows[0];
    const c=(await db.query<Claim>("SELECT * FROM academy_mcp_agent_claims WHERE token=$1 FOR UPDATE",[hashToken(token)])).rows[0];
    if(!r || !c || r.version!==1 || !alive(r.expires_at)||!alive(c.expires_at)||c.failures>=5||!c.verified_at||c.browser_hash!==hashToken(browser)||c.csrf_hash!==hashToken(csrf)||!await unblocked(db,c.email))return false;
    if(!/^\d{6}$/.test(code)||c.code_hash!==hashToken(`${r.id}:${code}`)) {await db.query("UPDATE academy_mcp_agent_claims SET failures=failures+1 WHERE token=$1",[c.token]);return false;}
    if(scopes.some(s=>s!=="learn:read"&&s!=="learn:write"))return false;
    await db.query("UPDATE academy_mcp_agent_registrations SET email=$2,version=2,scopes=$3,consented_at=NOW() WHERE id=$1",[r.id,c.email,[...new Set(scopes)]]);
    await db.query("DELETE FROM academy_mcp_agent_access_tokens WHERE registration_id=$1",[r.id]);
    await db.query("UPDATE academy_mcp_agent_claims SET csrf_hash=NULL,magic_hash=NULL WHERE token=$1",[c.token]);
    return true;
  });
}
export async function exchangeAgentAssertion(form:URLSearchParams) {
  if(form.has("resource")&&form.get("resource")!==MCP_RESOURCE)throw new AgentIdentityError("invalid_target");
  const assertion=verifyAgentAssertion(form.get("assertion")??"");if(!assertion)throw new AgentIdentityError("invalid_grant");
  return transaction(async db=>{
    const r=(await db.query<Registration>("SELECT * FROM academy_mcp_agent_registrations WHERE id=$1 FOR UPDATE",[assertion.sub])).rows[0];
    if(!r||!alive(r.expires_at)||r.version!==assertion.version||!await liveFamily(db,r.id)||(r.email&&!await unblocked(db,r.email)))throw new AgentIdentityError("invalid_grant");
    const scopes=form.has("scope")?[...new Set((form.get("scope")??"").trim().split(/\s+/).filter(Boolean))]:r.scopes;
    if(scopes.some(s=>!r.scopes.includes(s as Scope)))throw new AgentIdentityError("invalid_scope");
    return mintAccess(db,r,scopes as Scope[]);
  });
}
export async function pollAgentClaim(form:URLSearchParams) {
  if(form.has("resource")&&form.get("resource")!==MCP_RESOURCE)throw new AgentIdentityError("invalid_target");
  const outcome=await transaction(async db=>{
    const r=(await db.query<Registration>("SELECT * FROM academy_mcp_agent_registrations WHERE claim_hash=$1 FOR UPDATE",[hashToken(form.get("claim_token")??"")])).rows[0];
    if(!r)return {error:"invalid_grant"} as const;
    const c=(await db.query<Claim>("SELECT * FROM academy_mcp_agent_claims WHERE registration_id=$1 FOR UPDATE",[r.id])).rows[0];
    if(!alive(r.expires_at)||!c||!alive(c.expires_at))return {error:"expired_token"} as const;
    if(r.claim_delivered||!await liveFamily(db,r.id))return {error:"invalid_grant"} as const;
    if(c.last_poll_at&&Date.now()-c.last_poll_at.getTime()<c.poll_interval*1000) {
      await db.query("UPDATE academy_mcp_agent_claims SET last_poll_at=NOW(),poll_interval=LEAST(poll_interval+5,60) WHERE token=$1",[c.token]);return {error:"slow_down"} as const;
    }
    await db.query("UPDATE academy_mcp_agent_claims SET last_poll_at=NOW() WHERE token=$1",[c.token]);
    if(r.version!==2)return {error:"authorization_pending"} as const;
    if(!r.email||!await unblocked(db,r.email))return {error:"access_denied"} as const;
    const signed=signAgentAssertion(r.id,2,r.expires_at,r.email??undefined),pair=await mintAccess(db,r,r.scopes);
    await db.query("UPDATE academy_mcp_agent_registrations SET claim_delivered=true WHERE id=$1",[r.id]);
    return {pair:{...pair,...signed}} as const;
  });
  if("error" in outcome)throw new AgentIdentityError(outcome.error??"invalid_grant");
  return outcome.pair;
}
export async function authenticateAnonymousAgent(raw:string):Promise<boolean> {
  const result=await getDb().query(`SELECT 1 FROM academy_mcp_agent_access_tokens t JOIN academy_mcp_agent_registrations r ON r.id=t.registration_id
    WHERE t.token=$1 AND t.expires_at>NOW() AND r.expires_at>NOW() AND t.version=1 AND r.version=1 AND r.email IS NULL`,[hashToken(raw)]);
  return !!result.rowCount;
}
export async function revokeAgentAccess(raw:string):Promise<boolean> {
  return transaction(async db=>{
    const result=await db.query("DELETE FROM academy_mcp_agent_access_tokens WHERE token=$1 RETURNING token",[hashToken(raw)]);
    if(result.rowCount)await db.query("DELETE FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(raw)]);
    return !!result.rowCount;
  });
}
/** Expiry cleanup never changes the authority of an unexpired token. */
export async function cleanupAgentIdentities():Promise<void> {
  await getDb().query("DELETE FROM academy_mcp_agent_access_tokens WHERE expires_at<NOW()");
  await getDb().query("DELETE FROM academy_mcp_agent_claims WHERE expires_at<NOW()");
  await getDb().query("DELETE FROM academy_mcp_agent_registrations WHERE expires_at<NOW()");
}
