import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool,type PoolClient } from "pg";
import type { Transporter } from "nodemailer";
import { getDb,__setPoolForTest,closeDb } from "../src/db.js";
import { runMigration } from "../scripts/migrate.js";
import { handleOAuth } from "../src/auth/oauth.js";
import { handleMcp } from "../src/http.js";
import { __setTransportForTest } from "../src/auth/email-magic.js";
import { authenticateBearer } from "../src/auth/oauth-persistence.js";
import { MCP_RESOURCE } from "../src/auth/grants.js";
import { hashToken } from "../src/auth/token-hash.js";
import { ASSERTION_GRANT,CLAIM_GRANT } from "../src/auth/agent-assertions.js";
import { authenticateAnonymousAgent,registerAnonymousAgent,exchangeAgentAssertion,beginAgentClaim,bindClaimBrowser,prepareClaimMagic,verifyClaimMagic,approveAgentClaim,pollAgentClaim } from "../src/auth/agent-identity-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
const configured=new URL(process.env.ACADEMY_MCP_DATABASE_URL??"postgres://missing.invalid/no-database");
assert.ok(["localhost","127.0.0.1"].includes(configured.hostname));assert.equal(configured.port,"3431");assert.equal(configured.pathname,"/academy_rebuild");
const prefix=`agent_identity_${Date.now()}_${process.pid}`;
const form=(grant:string,fields:Record<string,string>)=>new URLSearchParams({grant_type:grant,...fields});
const decode=(raw:string)=>JSON.parse(Buffer.from(raw.split(".")[1],"base64url").toString());
function badCommit(pool:Pool):Pool {
  return new Proxy(pool,{get(target,key,receiver){if(key==="connect")return async()=>{
    const client=await target.connect();return new Proxy(client,{get(c,k){if(k==="query")return async(sql:string,values?:unknown[])=>{if(sql==="COMMIT")throw new Error("synthetic uncertain commit");return c.query(sql,values);};const v=Reflect.get(c,k);return typeof v==="function"?v.bind(c):v;}}) as PoolClient;
  };const value=Reflect.get(target,key,receiver);return typeof value==="function"?value.bind(target):value;}});
}
test("anonymous registration and real browser claim are durable, scoped and independent of existing PKCE",async t=>{
  const bootstrap=getDb();const identity=(await bootstrap.query("SELECT current_database() AS database,inet_server_addr()::text AS server")).rows[0];assert.equal(identity.database,"academy_rebuild");assert.ok(identity.server);
  const namespace=`academy_mcp_${prefix}`;await bootstrap.query(`CREATE SCHEMA ${namespace}`);
  const pool=new Pool({connectionString:configured.toString(),options:`-c search_path=${namespace}`,max:10});__setPoolForTest(pool);
  const previousSecret=process.env.ACADEMY_AGENT_ASSERTION_SECRET,previousBase=process.env.ACADEMY_MCP_BASE_URL,previousApi=process.env.ACADEMY_BASE_URL;
  process.env.ACADEMY_AGENT_ASSERTION_SECRET="synthetic-agent-assertion-secret-32-bytes-only";
  await runMigration();assert.equal((await pool.query("SELECT version FROM academy_mcp_schema_meta")).rows[0].version,4);
  const mails:Array<{to:string;text:string}>=[];
  __setTransportForTest({sendMail:async(input:{to:string;text:string})=>{mails.push(input);return {messageId:"synthetic"};}} as unknown as Transporter);
  const server=createServer((req,res)=>{void(async()=>{if(await handleOAuth(req,res))return;if(new URL(req.url??"/",process.env.ACADEMY_MCP_BASE_URL).pathname==="/mcp")return handleMcp(req,res);res.writeHead(404).end();})().catch(()=>res.writeHead(503).end());});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;process.env.ACADEMY_MCP_BASE_URL=origin;
  const fixture=JSON.parse(readFileSync(new URL("./root-api-index.fixture.json",import.meta.url),"utf8"));
  const api=createServer((req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(req.url==="/v1"?{success:true,result:fixture,errors:[],messages:[],request_id:"synthetic"}:{success:false,result:null,errors:[{code:1101,slug:"not_found",message:"Synthetic content missing",hint:"Search again",documentation_url:"https://studiomeyer.academy/v1/errors#not_found"}],messages:[],request_id:"synthetic"}));});
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));process.env.ACADEMY_BASE_URL=`http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  t.after(async()=>{
    __setTransportForTest(null);if(previousSecret===undefined)delete process.env.ACADEMY_AGENT_ASSERTION_SECRET;else process.env.ACADEMY_AGENT_ASSERTION_SECRET=previousSecret;if(previousBase===undefined)delete process.env.ACADEMY_MCP_BASE_URL;else process.env.ACADEMY_MCP_BASE_URL=previousBase;if(previousApi===undefined)delete process.env.ACADEMY_BASE_URL;else process.env.ACADEMY_BASE_URL=previousApi;
    await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>api.close(()=>resolve()))]);
    // The connection search_path contains only this freshly created test namespace.
    const ids=(await pool.query<{id:string}>("SELECT id FROM academy_mcp_agent_registrations")).rows.map(r=>r.id),families=ids.map(id=>`agent:${id}`);
    await pool.query("DELETE FROM academy_mcp_oauth_access_tokens WHERE client_id=ANY($1::text[])",[families]);
    await pool.query("DELETE FROM academy_mcp_oauth_revoked_families WHERE family_id=ANY($1::text[])",[families]);
    await pool.query("DELETE FROM academy_mcp_agent_registrations WHERE id=ANY($1::text[])",[ids]);
    __setPoolForTest(bootstrap);await pool.end();await closeDb();
  });
  const jsonPost=(path:string,data:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const tokenPost=(fields:URLSearchParams)=>fetch(origin+"/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:fields});
  await t.test("metadata advertises only actual configured anonymous profile and grant types",async()=>{
    const meta=await (await fetch(origin+"/.well-known/oauth-authorization-server")).json();assert.deepEqual(meta.agent_auth.identity_types_supported,["anonymous"]);assert.equal(meta.agent_auth.identity_endpoint,origin+"/agent/identity");assert.equal(meta.agent_auth.events_endpoint,undefined);assert.equal(meta.agent_auth.identity_assertion,undefined);assert.ok(meta.grant_types_supported.includes(ASSERTION_GRANT));assert.ok(meta.grant_types_supported.includes(CLAIM_GRANT));assert.ok(meta.grant_types_supported.includes("authorization_code"));
    delete process.env.ACADEMY_AGENT_ASSERTION_SECRET;assert.equal((await (await fetch(origin+"/.well-known/oauth-authorization-server")).json()).agent_auth,undefined);assert.equal((await jsonPost("/agent/identity",{type:"anonymous"})).status,503);process.env.ACADEMY_AGENT_ASSERTION_SECRET="synthetic-agent-assertion-secret-32-bytes-only";
    assert.equal((await jsonPost("/agent/identity",{type:"service_auth"})).status,400);assert.equal((await jsonPost("/agent/identity",{type:"identity_assertion"})).status,400);
  });
  const response=await jsonPost("/agent/identity",{type:"anonymous"});assert.equal(response.status,200);const registration=await response.json();assert.deepEqual(registration.pre_claim_scopes,[]);assert.deepEqual(registration.post_claim_scopes,["learn:read","learn:write"]);assert.equal(decode(registration.identity_assertion).email,undefined);
  const originalToken=await (await tokenPost(form(ASSERTION_GRANT,{assertion:registration.identity_assertion,resource:MCP_RESOURCE}))).json();assert.equal(originalToken.scope,"");assert.equal(await authenticateAnonymousAgent(originalToken.access_token),true);assert.equal(await authenticateBearer(originalToken.access_token),null);
  await t.test("anonymous token has only unchanged public SDK tools, and never forwards personal authority",async()=>{
    const client=new Client({name:"anonymous-profile-test",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${originalToken.access_token}`}}}));
    try{const listed=await client.listTools();assert.equal(listed.tools.length,29);assert.equal(listed.tools.some(tool=>tool.name==="academy_my_access"),false);const denied=await client.callTool({name:"academy_my_access",arguments:{}});assert.equal(denied.isError,true);assert.equal((denied.structuredContent as {errors:{slug:string}[]}).errors[0].slug,"auth_required");}finally{await client.close();}
    assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:registration.identity_assertion,scope:"learn:read"}))).status,400);assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:registration.identity_assertion,resource:"https://studiomeyer.academy/v1"}))).status,400);
    const tampered=registration.identity_assertion.slice(0,-8)+"tampered";assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:tampered}))).status,400);
  });
  await t.test("anonymous authority survives a real process restart without becoming a personal grant",async()=>{
    const scoped=new URL(configured);scoped.searchParams.set("options",`-c search_path=${namespace}`);
    const script="import {authenticateAnonymousAgent} from './src/auth/agent-identity-store.ts';import {authenticateBearer} from './src/auth/oauth-persistence.ts';import {closeDb} from './src/db.ts';console.log(JSON.stringify({public:await authenticateAnonymousAgent(process.env.TEST_ACCESS_TOKEN),personal:await authenticateBearer(process.env.TEST_ACCESS_TOKEN)}));await closeDb();";
    const run=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:process.cwd(),env:{...process.env,ACADEMY_MCP_DATABASE_URL:scoped.toString(),TEST_ACCESS_TOKEN:originalToken.access_token}});
    assert.deepEqual(JSON.parse(run.stdout),{public:true,personal:null});
  });
  const email=`${prefix}@example.com`;
  const claimResponse=await jsonPost("/agent/identity/claim",{claim_token:registration.claim_token,email});assert.equal(claimResponse.status,200);const claim=await claimResponse.json();assert.match(claim.claim_attempt.user_code,/^\d{6}$/);assert.equal(claim.claim_attempt.verification_uri.includes(claim.claim_attempt.user_code),false);
  const attempt=new URL(claim.claim_attempt.verification_uri).searchParams.get("claim_attempt_token")!;
  await t.test("claim is bound to one intended email and honors polling delay",async()=>{
    assert.equal((await jsonPost("/agent/identity/claim",{claim_token:registration.claim_token,email:`other-${email}`})).status,409);
    assert.equal((await (await tokenPost(form(CLAIM_GRANT,{claim_token:registration.claim_token}))).json()).error,"authorization_pending");
    assert.equal((await (await tokenPost(form(CLAIM_GRANT,{claim_token:registration.claim_token}))).json()).error,"slow_down");
  });
  const browserPage=await fetch(claim.claim_attempt.verification_uri);assert.equal(browserPage.status,200);const cookie=browserPage.headers.get("set-cookie")!.split(";")[0],html=await browserPage.text(),csrf=/name="csrf" value="([^"]+)"/.exec(html)![1];assert.equal(html.includes(email),false);
  const login=new URLSearchParams({claim_attempt_token:attempt,csrf,email});
  await t.test("only intended email and same-origin browser can obtain a claim login proof",async()=>{
    assert.equal((await fetch(origin+"/agent/identity/claim/verify",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:"https://foreign.invalid"},body:login})).status,403);assert.equal(mails.length,0);
    assert.equal((await fetch(origin+"/agent/identity/claim/verify",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:origin},body:login})).status,200);assert.equal(mails.length,1);assert.equal(mails[0].to,email);
  });
  const magicUrl=/https?:\/\/[^\s]+\/agent\/identity\/claim\/confirm\?[^\s]+/.exec(mails[0].text)![0];
  assert.equal((await fetch(magicUrl)).status,400);
  const confirmation=await fetch(magicUrl,{headers:{Cookie:cookie}});assert.equal(confirmation.status,200);const confirmHtml=await confirmation.text(),confirmCsrf=/name="csrf" value="([^"]+)"/.exec(confirmHtml)![1];assert.ok(confirmHtml.includes(email));assert.equal(/checked/.test(confirmHtml),false);assert.equal(confirmHtml.includes('value="credits:spend"'),false);
  const approve=new URLSearchParams({claim_attempt_token:attempt,csrf:confirmCsrf,user_code:claim.claim_attempt.user_code,scope:"learn:read",confirm:"yes"});
  await t.test("verified email alone, guessed code, forged CSRF and spending scope cannot claim",async()=>{
    const wrong=new URLSearchParams(approve);wrong.set("user_code","xxxxxx");assert.equal((await fetch(origin+"/agent/identity/claim/confirm",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:origin},body:wrong})).status,403);
    wrong.set("user_code",claim.claim_attempt.user_code);wrong.set("csrf","forged");assert.equal((await fetch(origin+"/agent/identity/claim/confirm",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:origin},body:wrong})).status,403);
    wrong.set("csrf",confirmCsrf);wrong.set("scope","credits:spend");assert.equal((await fetch(origin+"/agent/identity/claim/confirm",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:origin},body:wrong})).status,400);assert.equal(await authenticateAnonymousAgent(originalToken.access_token),true);
  });
  assert.equal((await fetch(origin+"/agent/identity/claim/confirm",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie,Origin:origin},body:approve})).status,200);
  assert.equal(await authenticateAnonymousAgent(originalToken.access_token),false);assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:registration.identity_assertion}))).status,400);
  await pool.query("UPDATE academy_mcp_agent_claims SET last_poll_at=NOW()-INTERVAL '2 minutes' WHERE registration_id=$1",[registration.registration_id]);
  const completion=await tokenPost(form(CLAIM_GRANT,{claim_token:registration.claim_token}));assert.equal(completion.status,200);const claimed=await completion.json();assert.equal(claimed.scope,"learn:read");assert.equal(decode(claimed.identity_assertion).email,email);assert.equal(decode(claimed.identity_assertion).email_verified,true);assert.deepEqual((await authenticateBearer(claimed.access_token))?.scopes,["learn:read"]);
  await t.test("claim credential is one-time, postclaim assertion narrows only and normal credential revocation preserves assertion",async()=>{
    assert.equal((await (await tokenPost(form(CLAIM_GRANT,{claim_token:registration.claim_token}))).json()).error,"invalid_grant");assert.equal((await jsonPost("/agent/identity/claim",{claim_token:registration.claim_token,email})).status,409);
    assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:claimed.identity_assertion,scope:"credits:spend"}))).status,400);
    const fresh=await (await tokenPost(form(ASSERTION_GRANT,{assertion:claimed.identity_assertion}))).json();assert.deepEqual((await authenticateBearer(fresh.access_token))?.scopes,["learn:read"]);
    assert.equal((await fetch(origin+"/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:fresh.access_token})})).status,200);assert.equal(await authenticateBearer(fresh.access_token),null);
    assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:claimed.identity_assertion}))).status,200);
    await pool.query("INSERT INTO academy_mcp_oauth_revoked_families(family_id) VALUES($1)",[`agent:${registration.registration_id}`]);assert.equal((await tokenPost(form(ASSERTION_GRANT,{assertion:claimed.identity_assertion}))).status,400);assert.equal(await authenticateBearer(claimed.access_token),null);
  });
  await t.test("concurrent claim initiation has one winner and persists across independent reads",async()=>{
    const r=await registerAnonymousAgent();const settled=await Promise.allSettled([beginAgentClaim(r.claim_token,email),beginAgentClaim(r.claim_token,email)]);assert.equal(settled.filter(v=>v.status==="fulfilled").length,1);assert.equal(settled.filter(v=>v.status==="rejected").length,1);assert.equal((await pool.query("SELECT count(*)::int AS count FROM academy_mcp_agent_claims WHERE registration_id=$1",[r.registration_id])).rows[0].count,1);
  });
  await t.test("registration and claim token delivery fail closed on uncertain commits",async()=>{
    const before=(await pool.query("SELECT count(*)::int AS count FROM academy_mcp_agent_registrations")).rows[0].count;__setPoolForTest(badCommit(pool));try{await assert.rejects(registerAnonymousAgent(),/uncertain commit/);}finally{__setPoolForTest(pool);}assert.equal((await pool.query("SELECT count(*)::int AS count FROM academy_mcp_agent_registrations")).rows[0].count,before);
    const r=await registerAnonymousAgent(),c=await beginAgentClaim(r.claim_token,email),token=new URL(c.claim_attempt.verification_uri).searchParams.get("claim_attempt_token")!;const nonce="synthetic-browser",csrf="synthetic-csrf";
    await bindClaimBrowser(token,nonce,csrf);const magic=await prepareClaimMagic(token,nonce,csrf,email);assert.ok(magic);await verifyClaimMagic(magic,nonce);assert.equal(await approveAgentClaim(token,nonce,csrf,c.claim_attempt.user_code,["learn:write"]),true);
    __setPoolForTest(badCommit(pool));try{await assert.rejects(pollAgentClaim(form(CLAIM_GRANT,{claim_token:r.claim_token})),/uncertain commit/);}finally{__setPoolForTest(pool);}
    assert.equal((await pool.query("SELECT claim_delivered FROM academy_mcp_agent_registrations WHERE id=$1",[r.registration_id])).rows[0].claim_delivered,false);assert.equal((await pool.query("SELECT count(*)::int AS count FROM academy_mcp_agent_access_tokens WHERE registration_id=$1",[r.registration_id])).rows[0].count,0);
    const pair=await pollAgentClaim(form(CLAIM_GRANT,{claim_token:r.claim_token}));assert.deepEqual((await authenticateBearer(pair.access_token))?.scopes,["learn:write"]);
  });
  await t.test("expired attempts may restart only for the originally bound email",async()=>{
    const r=await registerAnonymousAgent();await beginAgentClaim(r.claim_token,email);await pool.query("UPDATE academy_mcp_agent_claims SET expires_at=NOW()-INTERVAL '1 second' WHERE registration_id=$1",[r.registration_id]);await assert.rejects(beginAgentClaim(r.claim_token,`other-${email}`));assert.equal((await beginAgentClaim(r.claim_token,email)).status,"initiated");
    const stored=(await pool.query("SELECT claim_hash FROM academy_mcp_agent_registrations WHERE id=$1",[r.registration_id])).rows[0];assert.equal(stored.claim_hash,hashToken(r.claim_token));assert.notEqual(stored.claim_hash,r.claim_token);
    const exchanged=await exchangeAgentAssertion(form(ASSERTION_GRANT,{assertion:r.identity_assertion}));assert.equal(await authenticateAnonymousAgent(exchanged.access_token),true);
  });
  await t.test("five wrong codes durably lock the ceremony and expiry prevents claim",async()=>{
    const r=await registerAnonymousAgent(),c=await beginAgentClaim(r.claim_token,email),token=new URL(c.claim_attempt.verification_uri).searchParams.get("claim_attempt_token")!;
    const nonce="synthetic-lock-browser",csrf="synthetic-lock-csrf";
    await bindClaimBrowser(token,nonce,csrf);const magic=await prepareClaimMagic(token,nonce,csrf,email);assert.ok(magic);await verifyClaimMagic(magic,nonce);
    for(let i=0;i<5;i++)assert.equal(await approveAgentClaim(token,nonce,csrf,"wrong",["learn:read"]),false);
    assert.equal(await approveAgentClaim(token,nonce,csrf,c.claim_attempt.user_code,["learn:read"]),false);
    assert.equal((await pool.query("SELECT failures FROM academy_mcp_agent_claims WHERE token=$1",[hashToken(token)])).rows[0].failures,5);
    const expiry=await registerAnonymousAgent();await pool.query("UPDATE academy_mcp_agent_registrations SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[expiry.registration_id]);await assert.rejects(beginAgentClaim(expiry.claim_token,email));await assert.rejects(exchangeAgentAssertion(form(ASSERTION_GRANT,{assertion:expiry.identity_assertion})));
  });

  await t.test("verified email blocking denies claim and later assertion exchange without affecting public identity",async()=>{
    const r=await registerAnonymousAgent(),c=await beginAgentClaim(r.claim_token,email),token=new URL(c.claim_attempt.verification_uri).searchParams.get("claim_attempt_token")!,nonce="synthetic-block-browser",csrf="synthetic-block-csrf";
    await bindClaimBrowser(token,nonce,csrf);assert.equal(await approveAgentClaim(token,nonce,csrf,c.claim_attempt.user_code,["learn:read"]),false);
    const magic=await prepareClaimMagic(token,nonce,csrf,email);assert.ok(magic);await verifyClaimMagic(magic,nonce);
    await pool.query("INSERT INTO academy_mcp_blocked(email,reason) VALUES($1,$2)",[email,"synthetic test block"]);
    try {assert.equal(await approveAgentClaim(token,nonce,csrf,c.claim_attempt.user_code,["learn:read"]),false);}finally{await pool.query("DELETE FROM academy_mcp_blocked WHERE email=$1",[email]);}
    const outcomes=await Promise.all([approveAgentClaim(token,nonce,csrf,c.claim_attempt.user_code,["learn:read"]),approveAgentClaim(token,nonce,csrf,c.claim_attempt.user_code,["learn:write"])]);assert.equal(outcomes.filter(Boolean).length,1);
    const issued=await Promise.allSettled([pollAgentClaim(form(CLAIM_GRANT,{claim_token:r.claim_token})),pollAgentClaim(form(CLAIM_GRANT,{claim_token:r.claim_token}))]);assert.equal(issued.filter(v=>v.status==="fulfilled").length,1);
    const winner=issued.find(v=>v.status==="fulfilled");assert.ok(winner?.status==="fulfilled");
    await pool.query("INSERT INTO academy_mcp_blocked(email,reason) VALUES($1,$2)",[email,"synthetic test block"]);
    try {assert.equal(await authenticateBearer(winner.value.access_token),null);await assert.rejects(exchangeAgentAssertion(form(ASSERTION_GRANT,{assertion:winner.value.identity_assertion})));}finally{await pool.query("DELETE FROM academy_mcp_blocked WHERE email=$1",[email]);}
  });
  await t.test("claim browser forms preserve DE EN ES and keep permission choices unchecked",async()=>{
    for(const locale of ["de","en","es"]){
      const r=await registerAnonymousAgent(),c=await beginAgentClaim(r.claim_token,email),url=new URL(c.claim_attempt.verification_uri);url.searchParams.set("lang",locale);
      const response=await fetch(url),html=await response.text();assert.equal(response.status,200);assert.ok(html.includes(`<html lang="${locale}">`));assert.ok(html.includes('type="email"'));assert.ok(!html.includes(email));
    }
  });

});
