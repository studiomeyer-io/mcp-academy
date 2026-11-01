import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { Transporter } from "nodemailer";
import type { Pool,PoolClient } from "pg";
import { getDb,closeDb,__setPoolForTest } from "../src/db.js";
import { hashToken } from "../src/auth/token-hash.js";
import { saveAuthCode,redeemCode,rotateRefresh,authenticateBearer,revokeToken,randomToken,type Authorization,type TokenPair } from "../src/auth/oauth-persistence.js";
import { MCP_RESOURCE,REST_RESOURCE } from "../src/auth/grants.js";
import { handleOAuth,hydrateOAuthState } from "../src/auth/oauth.js";
import { __setTransportForTest } from "../src/auth/email-magic.js";
import { createProviderState,consumeProviderState,normalizeProfile } from "../src/auth/social-providers.js";
const execute=promisify(execFile);
const configured=new URL(process.env.ACADEMY_MCP_DATABASE_URL ?? "postgres://missing.invalid/no-database");
if(configured.hostname!=="127.0.0.1" || configured.port!=="3431" || configured.pathname!=="/academy_rebuild")throw new Error("OAuth tests require the isolated 127.0.0.1:3431/academy_rebuild database");
const prefix=`mcpbuild_${Date.now()}_${process.pid}`;
const verifier="v".repeat(43);const challenge=createHash("sha256").update(verifier).digest("base64url");
const email=`${prefix}@example.com`;const clientId=prefix;
const authorization:Authorization & {email:string}={client_id:clientId,redirect_uri:"http://127.0.0.1:3449/callback",code_challenge:challenge,state:"client-state",scopes:["learn:read","learn:write","credits:spend"],resource:MCP_RESOURCE,grant_version:2,consented_at:new Date(),browser_hash:hashToken("browser"),email};
const codeForm=(code:string)=>new URLSearchParams({grant_type:"authorization_code",code,client_id:clientId,redirect_uri:authorization.redirect_uri,code_verifier:verifier,resource:MCP_RESOURCE});
const refreshForm=(pair:TokenPair)=>new URLSearchParams({grant_type:"refresh_token",refresh_token:pair.refresh_token,client_id:clientId});
async function pair(overrides:Partial<Authorization>={}):Promise<TokenPair> {const code=await saveAuthCode({...authorization,...overrides});const form=codeForm(code);if(overrides.resource)form.set("resource",overrides.resource);const result=await redeemCode(form);assert.equal(result.ok,true);if(!result.ok)throw new Error(result.error);return result.pair;}

function deferred() {let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function legacyNullPair():Promise<TokenPair & {family:string}> {
  const access=randomToken(),refresh=randomToken(),db=getDb();
  await db.query("INSERT INTO academy_mcp_oauth_access_tokens(token,client_id,email,family_id,expires_at) VALUES($1,$2,$3,NULL,NOW()+INTERVAL '1 hour')",[hashToken(access),clientId,email]);
  await db.query("INSERT INTO academy_mcp_oauth_refresh_tokens(token,client_id,email,family_id,access_token,expires_at) VALUES($1,$2,$3,NULL,$4,NOW()+INTERVAL '30 days')",[hashToken(refresh),clientId,email,hashToken(access)]);
  return {access_token:access,refresh_token:refresh,family:hashToken(access),token_type:"Bearer",expires_in:3600,scope:"learn:read",resource:MCP_RESOURCE};
}

test("persistent OAuth grants, replay, restart, browser binding and commit semantics",async t=>{
  const db=getDb();
  const identity=await db.query<{database:string;server:string}>("SELECT current_database() AS database,inet_server_addr()::text AS server");
  assert.equal(identity.rows[0].database,"academy_rebuild");assert.ok(identity.rows[0].server);await hydrateOAuthState();
  t.after(async()=>{
    for(const table of ["auth_codes","access_tokens","refresh_tokens","magic_links","provider_states","authorizations","clients"])await db.query(`DELETE FROM academy_mcp_oauth_${table} WHERE client_id LIKE $1`,[`${prefix}%`]);
    await db.query("DELETE FROM academy_mcp_oauth_refresh_tombstones WHERE client_id LIKE $1",[`${prefix}%`]);
    await db.query("DELETE FROM academy_mcp_blocked WHERE email LIKE $1",[`${prefix}%`]);
    await closeDb();
  });
  const initial=await pair();assert.match(initial.scope,/credits:spend/);assert.equal(initial.resource,MCP_RESOURCE);
  const persisted=await db.query<{token:string;scopes:string[];resource:string;grant_version:number;consented_at:Date;family_id:string}>("SELECT * FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(initial.access_token)]);
  assert.equal(persisted.rows[0].token,hashToken(initial.access_token));assert.notEqual(persisted.rows[0].token,initial.access_token);assert.equal(persisted.rows[0].grant_version,2);assert.ok(persisted.rows[0].consented_at);
  assert.equal((await authenticateBearer(initial.access_token))?.email,email);
  const broaden=refreshForm(initial);broaden.set("scope","mcp:write");assert.deepEqual(await rotateRefresh(broaden),{ok:false,error:"invalid_scope"});
  const mismatch=refreshForm(initial);mismatch.set("resource",REST_RESOURCE);assert.deepEqual(await rotateRefresh(mismatch),{ok:false,error:"invalid_target"});
  const narrow=refreshForm(initial);narrow.set("scope","learn:read");const rotation=await rotateRefresh(narrow);assert.equal(rotation.ok,true);if(!rotation.ok)throw new Error("narrow failed");assert.equal(rotation.pair.scope,"learn:read");assert.equal(await authenticateBearer(initial.access_token),null);
  const modernRotated=await db.query<{family_id:string}>("SELECT family_id FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(rotation.pair.access_token)]);assert.equal(modernRotated.rows[0].family_id,persisted.rows[0].family_id);
  const respawn=await execute(process.execPath,["--import","tsx","--input-type=module","-e",`import {authenticateBearer} from './src/auth/oauth-persistence.ts';import {closeDb} from './src/db.ts';const value=await authenticateBearer(process.env.TEST_ACCESS_TOKEN);console.log(JSON.stringify({scopes:value?.scopes}));await closeDb();`],{cwd:process.cwd(),env:{...process.env,TEST_ACCESS_TOKEN:rotation.pair.access_token}});
  assert.deepEqual(JSON.parse(respawn.stdout.trim()),{scopes:["learn:read"]});
  const replayAfterRestart=await execute(process.execPath,["--import","tsx","--input-type=module","-e",`import {rotateRefresh} from './src/auth/oauth-persistence.ts';import {closeDb} from './src/db.ts';console.log(JSON.stringify(await rotateRefresh(new URLSearchParams({refresh_token:process.env.TEST_REFRESH_TOKEN,client_id:process.env.TEST_CLIENT_ID}))));await closeDb();`],{cwd:process.cwd(),env:{...process.env,TEST_REFRESH_TOKEN:initial.refresh_token,TEST_CLIENT_ID:clientId}});
  assert.deepEqual(JSON.parse(replayAfterRestart.stdout.trim()),{ok:false,error:"invalid_grant"});assert.equal(await authenticateBearer(rotation.pair.access_token),null);
  await t.test("failed commit returns no token pair and rolls redemption back",async()=>{
    const code=await saveAuthCode(authorization);
    const brokenPool=new Proxy(db,{get(target,key,receiver){
      if(key==="connect")return async()=>{
        const client=await target.connect();
        return new Proxy(client,{get(connection,property){
          if(property==="query")return async(sql:string,values?:unknown[])=>{
            if(sql==="COMMIT")throw new Error("injected commit failure");
            return connection.query(sql,values);
          };
          const value=Reflect.get(connection,property);return typeof value==="function" ? value.bind(connection) : value;
        }}) as PoolClient;
      };
      return Reflect.get(target,key,receiver);
    }}) as Pool;
    __setPoolForTest(brokenPool);
    try {await assert.rejects(redeemCode(codeForm(code)),/injected commit failure/);} finally {__setPoolForTest(db);}
    const stored=await db.query("SELECT code FROM academy_mcp_oauth_auth_codes WHERE code=$1",[hashToken(code)]);assert.equal(stored.rowCount,1);
    const result=await redeemCode(codeForm(code));assert.equal(result.ok,true);
  });
  await t.test("parallel code redemption has one winner and persistent single-use",async()=>{
    const code=await saveAuthCode(authorization);const results=await Promise.all([redeemCode(codeForm(code)),redeemCode(codeForm(code))]);assert.equal(results.filter(r=>r.ok).length,1);
    assert.deepEqual(await redeemCode(codeForm(code)),{ok:false,error:"invalid_grant"});
    const invalidCode=await saveAuthCode(authorization);const bad=codeForm(invalidCode);bad.set("code_verifier","x".repeat(43));assert.equal((await redeemCode(bad)).ok,false);assert.equal((await redeemCode(codeForm(invalidCode))).ok,false);
  });
  await t.test("parallel refresh replay revokes the winning descendant",async()=>{
    const current=await pair();const results=await Promise.all([rotateRefresh(refreshForm(current)),rotateRefresh(refreshForm(current))]);assert.equal(results.filter(r=>r.ok).length,1);
    const winner=results.find(r=>r.ok);assert.ok(winner?.ok);if(winner?.ok)assert.equal(await authenticateBearer(winner.pair.access_token),null);
  });
  await t.test("REST audience is rejected by MCP and blocking revocation persist",async()=>{
    const rest=await pair({resource:REST_RESOURCE});assert.equal(await authenticateBearer(rest.access_token),null);assert.ok(await authenticateBearer(rest.access_token,REST_RESOURCE));
    const blocked=await pair();await db.query("INSERT INTO academy_mcp_blocked(email) VALUES($1)",[email]);assert.equal(await authenticateBearer(blocked.access_token),null);assert.deepEqual(await rotateRefresh(refreshForm(blocked)),{ok:false,error:"access_denied"});await db.query("DELETE FROM academy_mcp_blocked WHERE email=$1",[email]);
    const revoked=await pair();await revokeToken(revoked.refresh_token,clientId);assert.equal(await authenticateBearer(revoked.access_token),null);assert.equal((await rotateRefresh(refreshForm(revoked))).ok,false);
  });
  await t.test("legacy null-scope tokens remain read-only through refresh",async()=>{
    const legacy=await legacyNullPair();const access=legacy.access_token,refresh=legacy.refresh_token;
    const stored=await db.query<{family_id:string|null;access_token:string}>("SELECT family_id,access_token FROM academy_mcp_oauth_refresh_tokens WHERE token=$1",[hashToken(refresh)]);
    assert.equal(stored.rows[0].family_id,null);assert.equal(stored.rows[0].access_token,hashToken(access));assert.notEqual(hashToken(access),hashToken(refresh));
    assert.deepEqual((await authenticateBearer(access))?.scopes,["learn:read"]);
    const expand=new URLSearchParams({refresh_token:refresh,client_id:clientId,scope:"credits:spend"});assert.deepEqual(await rotateRefresh(expand),{ok:false,error:"invalid_scope"});expand.delete("scope");const result=await rotateRefresh(expand);assert.ok(result.ok);if(result.ok){assert.equal(result.pair.scope,"learn:read");assert.equal((await authenticateBearer(result.pair.access_token))?.consented_at,null);}
  });
  await t.test("NULL legacy access and refresh handles revoke the same family before and after rotation",async()=>{
    for(const handle of ["access_token","refresh_token"] as const) {
      const legacy=await legacyNullPair();await revokeToken(legacy[handle],clientId);
      assert.equal(await authenticateBearer(legacy.access_token),null);assert.deepEqual(await rotateRefresh(refreshForm(legacy)),{ok:false,error:"invalid_grant"});
      const tomb=await db.query<{family_id:string}>("SELECT family_id FROM academy_mcp_oauth_refresh_tombstones WHERE token=$1",[hashToken(legacy.refresh_token)]);assert.equal(tomb.rows[0]?.family_id,legacy.family);
    }
    const legacy=await legacyNullPair();const rotated=await rotateRefresh(refreshForm(legacy));assert.ok(rotated.ok);if(!rotated.ok)throw new Error("Legacy rotation failed");
    const current=await db.query<{family_id:string}>("SELECT family_id FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(rotated.pair.access_token)]);assert.equal(current.rows[0].family_id,legacy.family);
    await revokeToken(legacy.access_token,clientId);assert.equal(await authenticateBearer(rotated.pair.access_token),null);assert.equal((await rotateRefresh(refreshForm(rotated.pair))).ok,false);
  });
  await t.test("browser disconnect invalidates an overlapping NULL-family legacy refresh",async()=>{
    const legacy=await legacyNullPair();const refreshChecked=deferred(),continueRefresh=deferred();
    const instrumentedPool=new Proxy(db,{get(target,key,receiver){
      if(key==="connect")return async()=>{
        const connection=await target.connect();
        return new Proxy(connection,{get(client,property){
          if(property==="query")return async(sql:string,values?:unknown[])=>{
            const result=await client.query(sql,values);
            if(sql==="SELECT 1 FROM academy_mcp_oauth_revoked_families WHERE family_id=$1") {refreshChecked.resolve();await continueRefresh.promise;}
            return result;
          };
          const value=Reflect.get(client,property);return typeof value==="function" ? value.bind(client) : value;
        }}) as PoolClient;
      };
      return Reflect.get(target,key,receiver);
    }}) as Pool;
    const browser=await db.connect();let browserTransaction=false;
    __setPoolForTest(instrumentedPool);
    try {
      const rotating=rotateRefresh(refreshForm(legacy));await refreshChecked.promise;
      // Root disconnect uses the access family/handle and writes a durable tombstone
      // before removing refresh/access rows. Its refresh DELETE can wait on rotation.
      await browser.query("BEGIN");browserTransaction=true;
      await browser.query("INSERT INTO academy_mcp_oauth_revoked_families(family_id) VALUES($1) ON CONFLICT DO NOTHING",[legacy.family]);
      const removingRefresh=browser.query("DELETE FROM academy_mcp_oauth_refresh_tokens WHERE client_id=$1 AND (family_id=$2 OR access_token=$2)",[clientId,legacy.family]);
      continueRefresh.resolve();const rotated=await rotating;__setPoolForTest(db);assert.ok(rotated.ok);if(!rotated.ok)throw new Error("Controlled refresh did not reach commit");
      const minted=await db.query<{family_id:string;grant_version:number;consented_at:Date|null}>("SELECT family_id,grant_version,consented_at FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(rotated.pair.access_token)]);
      assert.equal(minted.rows[0].family_id,legacy.family);assert.equal(minted.rows[0].grant_version,1);assert.equal(minted.rows[0].consented_at,null);assert.equal(rotated.pair.scope,"learn:read");assert.equal(rotated.pair.resource,MCP_RESOURCE);
      await removingRefresh;
      await browser.query("DELETE FROM academy_mcp_oauth_access_tokens WHERE client_id=$1 AND (family_id=$2 OR token=$2)",[clientId,legacy.family]);
      await browser.query("COMMIT");browserTransaction=false;
      assert.equal(await authenticateBearer(legacy.access_token),null);assert.equal(await authenticateBearer(rotated.pair.access_token),null);assert.equal((await rotateRefresh(refreshForm(rotated.pair))).ok,false);
      const tomb=await db.query<{family_id:string}>("SELECT family_id FROM academy_mcp_oauth_refresh_tombstones WHERE token=$1",[hashToken(legacy.refresh_token)]);assert.equal(tomb.rows[0].family_id,legacy.family);
    } finally {continueRefresh.resolve();__setPoolForTest(db);if(browserTransaction)await browser.query("ROLLBACK");browser.release();}
  });
  await t.test("provider states retain grants, bind browser and require verified email",async()=>{
    const state=await createProviderState({provider:"google",client_id:clientId,redirect_uri:authorization.redirect_uri,pkce_challenge:challenge,client_state:"state",grant:authorization,browser_hash:authorization.browser_hash});
    assert.equal(await consumeProviderState(state,hashToken("other-browser")),null);const result=await consumeProviderState(state,authorization.browser_hash);assert.ok(result);assert.deepEqual(result.scopes,authorization.scopes);assert.equal(result.resource,MCP_RESOURCE);assert.equal(result.grant_version,2);assert.equal(await consumeProviderState(state,authorization.browser_hash),null);
    assert.throws(()=>normalizeProfile("google",{sub:"123",email,email_verified:false}),/not_verified/);assert.throws(()=>normalizeProfile("discord",{id:"123",email,verified:false}),/not_verified/);
  });
  await t.test("real DCR/consent/magic flow is browser-bound and spend defaults off in de/en/es",async context=>{
    let mail="";__setTransportForTest({sendMail:async(value:{text:string})=>{mail=value.text;return {};}} as unknown as Transporter);
    context.after(()=>__setTransportForTest(null));
    const server=createServer((req,res)=>{void handleOAuth(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{res.writeHead(500);res.end();});});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));context.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registration=await fetch(`${origin}/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Synthetic test",redirect_uris:[authorization.redirect_uri]})});assert.equal(registration.status,201);const registered=await registration.json() as {client_id:string;client_secret?:string};assert.equal(registered.client_secret,undefined);
    await db.query("UPDATE academy_mcp_oauth_clients SET client_id=$1 WHERE client_id=$2",[`${prefix}_browser`,registered.client_id]);const browserClient=`${prefix}_browser`;
    for(const locale of ["de","en","es"]) {
      const query=new URLSearchParams({client_id:browserClient,redirect_uri:authorization.redirect_uri,response_type:"code",code_challenge:challenge,code_challenge_method:"S256",scope:"learn:read learn:write credits:spend",resource:MCP_RESOURCE,state:"returned-state",lang:locale});
      const response=await fetch(`${origin}/authorize?${query}`);assert.equal(response.status,200);const html=await response.text();assert.match(html,new RegExp(`<html lang="${locale}"`));assert.match(html,/name="scope" value="credits:spend">/);assert.doesNotMatch(html,/value="credits:spend" checked/);
      if(locale!=="de")continue;
      const cookie=response.headers.get("set-cookie")!.split(";")[0];assert.match(cookie,/academy_oauth_browser=/);assert.match(response.headers.get("set-cookie")!,/HttpOnly; SameSite=Lax/);
      const requestId=html.match(/name="request_id" value="([^"]+)"/)![1];const csrf=html.match(/name="csrf" value="([^"]+)"/)![1];
      const form=new URLSearchParams({request_id:requestId,csrf,method:"email",email,scope:"learn:read"});
      const forged=await fetch(`${origin}/authorize`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});assert.equal(forged.status,403);assert.equal(mail,"");
      const submit=await fetch(`${origin}/authorize`,{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/x-www-form-urlencoded"},body:form});assert.equal(submit.status,200);assert.ok(mail.includes("/authorize/verify?token="));
      const emailed=mail.match(/https?:\/\/[^\s]+\/authorize\/verify\?[^\s]+/)![0];const verification=new URL(emailed);const verifyUrl=`${origin}${verification.pathname}${verification.search}`;
      const wrongBrowser=await fetch(verifyUrl,{redirect:"manual"});assert.equal(wrongBrowser.status,400);
      const verified=await fetch(verifyUrl,{headers:{Cookie:cookie},redirect:"manual"});assert.equal(verified.status,302);const returned=new URL(verified.headers.get("location")!);assert.equal(returned.searchParams.get("state"),"returned-state");assert.ok(returned.searchParams.get("iss"));
      const formCode=new URLSearchParams({code:returned.searchParams.get("code")!,client_id:browserClient,redirect_uri:authorization.redirect_uri,code_verifier:verifier,grant_type:"authorization_code"});
      const token=await fetch(`${origin}/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:formCode});assert.equal(token.status,200);const output=await token.json() as TokenPair;assert.equal(output.scope,"learn:read");assert.equal((await authenticateBearer(output.access_token))?.grant_version,2);
      assert.equal((await fetch(verifyUrl,{headers:{Cookie:cookie},redirect:"manual"})).status,400);
    }
  });
});
