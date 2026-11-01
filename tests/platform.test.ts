import test from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../src/server.js";
import { handleMcp } from "../src/http.js";
import { executeOperation,loadRegistry,toolsFor,readDocumentation,type Registry } from "../src/academy-client.js";
import { MCP_RESOURCE,REST_RESOURCE,type Grant } from "../src/auth/grants.js";
import type { AddressInfo } from "node:net";
const outputSchema={type:"object",required:["operation","locale","input"],properties:{operation:{type:"string"},locale:{enum:["de","en","es"]},input:{type:"object"}},additionalProperties:false};
const inputSchema={type:"object" as const,properties:{query:{type:"string"},id:{type:"string"},consent:{type:"object",properties:{userConfirmed:{const:true},quoteId:{type:"string"},maximumCredits:{type:"number"}},required:["userConfirmed","quoteId","maximumCredits"],additionalProperties:false}},additionalProperties:false};
const registry:Registry={operations:[
  {id:"start",description:"Start",rest:[],mcp:{names:["academy_start","search","fetch"],deprecatedAliases:["academy_welcome"],annotations:{readOnlyHint:true}},inputSchema,outputSchema,requiredScopes:[],creditEffect:"none",public:true},
  {id:"notes",description:"Notes",rest:[],mcp:{names:["academy_notes"],deprecatedAliases:[],annotations:{readOnlyHint:true}},inputSchema,outputSchema,requiredScopes:["learn:read"],creditEffect:"none",public:false},
  {id:"save",description:"Save",rest:[],mcp:{names:["academy_note_save"],deprecatedAliases:[],annotations:{readOnlyHint:false}},inputSchema,outputSchema,requiredScopes:["learn:write"],creditEffect:"none",public:false},
  {id:"unlock",description:"Unlock",rest:[],mcp:{names:["academy_premium_unlock"],deprecatedAliases:[],annotations:{readOnlyHint:false}},inputSchema:{...inputSchema,required:["consent"]},outputSchema,requiredScopes:["credits:spend"],creditEffect:"spend",public:false},
]};
const grant:Grant={scopes:["learn:read"],resource:MCP_RESOURCE,grant_version:2,consented_at:new Date()};
const envelope=(result:unknown)=>({success:true,result,errors:[],messages:[],request_id:"req_mock"});

test("live registry and real SDK enforce anonymous, scope, audience and service boundaries",async t=>{
  const calls:Array<{headers:Record<string,unknown>;body:Record<string,unknown>}> = [];
  let brokenRegistry=false;let badOutput=false;
  const api=httpServer(async(req,res)=>{
    if(req.url==="/v1") {res.setHeader("Content-Type","application/json");res.end(JSON.stringify(brokenRegistry ? {} : envelope(registry)));return;}
    if(req.url==="/api/academy/execute") {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
      calls.push({headers:req.headers,body});res.setHeader("Content-Type","application/json");res.end(JSON.stringify(badOutput ? {success:true} : envelope({operation:body.operation,locale:body.locale,input:body.input})));return;
    }
    res.setHeader("Content-Type","text/markdown");res.end(`# Live ${req.url}`);
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
  const previousService=process.env.ACADEMY_MCP_SERVICE_TOKEN;delete process.env.ACADEMY_MCP_SERVICE_TOKEN;
  const previous=process.env.ACADEMY_BASE_URL;process.env.ACADEMY_BASE_URL=`http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  t.after(async()=>{process.env.ACADEMY_BASE_URL=previous;await new Promise<void>(resolve=>api.close(()=>resolve()));});
  const live=await loadRegistry();assert.equal(live.operations.length,4);
  assert.deepEqual(toolsFor(live,null).map(tool=>tool.name),["academy_start","search","fetch","academy_welcome"]);
  assert.equal(toolsFor(live,grant).some(tool=>tool.name==="academy_note_save"),false);
  assert.equal(toolsFor(live,{...grant,resource:REST_RESOURCE}).some(tool=>tool.name==="academy_notes"),false);
  const pair=InMemoryTransport.createLinkedPair();const server=createServer();const client=new Client({name:"test",version:"1"});
  await server.connect(pair[0]);await client.connect(pair[1]);t.after(async()=>{await client.close();await server.close();});
  assert.match(client.getInstructions() ?? "",/academy_start/);
  const tools=await client.listTools();assert.ok(tools.tools.every(tool=>tool.outputSchema));
  const start=await client.callTool({name:"academy_start",arguments:{}});
  assert.equal(start.isError,false);assert.equal((start.structuredContent as {result:{locale:string}}).result.locale,"de");
  const search=await client.callTool({name:"search",arguments:{query:"test"}});assert.equal(search.isError,false);
  const fetchCall=await client.callTool({name:"fetch",arguments:{id:"public-id"}});assert.equal(fetchCall.isError,false);
  const bypass=await client.callTool({name:"academy_note_save",arguments:{}});assert.equal(bypass.isError,true);
  assert.equal((bypass.structuredContent as {errors:Array<{slug:string}>}).errors[0].slug,"auth_required");
  assert.equal(calls.length,3);assert.equal(calls[0].headers.authorization,undefined);assert.equal(calls[0].headers["x-academy-service-authorization"],undefined);
  const docs=await client.listResources();assert.equal(docs.resources.length,3);
  assert.match(await readDocumentation("academy://docs/package-format",live),/^# Live \/entwickler\/paketformat.md/);
  const missing=await executeOperation(live,"academy_notes",{},{grant,accessToken:"synthetic-user-token",revalidate:async()=>grant});assert.equal(missing.errors[0].slug,"temporarily_unavailable");assert.equal(calls.length,3);
  process.env.ACADEMY_MCP_SERVICE_TOKEN="synthetic-service-token";
  t.after(()=>{if(previousService===undefined)delete process.env.ACADEMY_MCP_SERVICE_TOKEN;else process.env.ACADEMY_MCP_SERVICE_TOKEN=previousService;});
  const notes=await executeOperation(live,"academy_notes",{locale:"es"},{grant,accessToken:"synthetic-user-token",revalidate:async()=>grant});assert.equal(notes.success,true);
  assert.equal(calls.at(-1)?.headers.authorization,"Bearer synthetic-user-token");assert.equal(calls.at(-1)?.headers["x-academy-service-authorization"],"Bearer synthetic-service-token");assert.equal(calls.at(-1)?.headers["x-academy-user"],undefined);
  const count=calls.length;
  assert.equal((await executeOperation(live,"academy_note_save",{},{grant,accessToken:"x",revalidate:async()=>grant})).errors[0].slug,"insufficient_scope");
  assert.equal((await executeOperation(live,"academy_premium_unlock",{userConfirmed:true,idempotencyKey:"x"},{grant,accessToken:"x",revalidate:async()=>grant})).errors[0].slug,"credits_spend_not_granted");
  const spend={...grant,scopes:["credits:spend" as const]};
  assert.equal((await executeOperation(live,"academy_premium_unlock",{},{grant:spend,accessToken:"x",revalidate:async()=>spend})).errors[0].slug,"validation_failed");
  assert.equal((await executeOperation(live,"academy_premium_unlock",{consent:{userConfirmed:true,quoteId:"quote",maximumCredits:5}},{grant:spend,accessToken:"x",revalidate:async()=>spend})).errors[0].slug,"idempotency_key_required");
  assert.equal((await executeOperation(live,"academy_notes",{},{grant,accessToken:"x",revalidate:async()=>null})).errors[0].slug,"auth_required");
  assert.equal((await executeOperation(live,"academy_notes",{},{grant:{...grant,resource:REST_RESOURCE},accessToken:"x",revalidate:async()=>({...grant,resource:REST_RESOURCE})})).success,false);
  assert.equal(calls.length,count);
  assert.equal((await executeOperation(live,"academy_start",{locale:"fr"},null)).errors[0].slug,"locale_not_supported");
  assert.equal((await executeOperation(live,"academy_start",{unknown:true},null)).errors[0].slug,"validation_failed");
  badOutput=true;assert.equal((await executeOperation(live,"academy_start",{},null)).errors[0].slug,"temporarily_unavailable");badOutput=false;
  brokenRegistry=true;await assert.rejects(client.listTools(),error=>!!(error && typeof error==="object" && "data" in error && (error.data as {request_id?:string})?.request_id));const failure=await client.callTool({name:"academy_start",arguments:{}});assert.equal(failure.isError,true);assert.ok((failure.structuredContent as {request_id:string}).request_id);brokenRegistry=false;

  // Real HTTP SDK initialization and calls, with the hosted free selector.
  const hosted=httpServer((req,res)=>{void handleMcp(req,res).catch(()=>{res.writeHead(500);res.end();});});
  await new Promise<void>(resolve=>hosted.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise<void>(resolve=>hosted.close(()=>resolve()));});
  const origin=`http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
  const protectedResponse=await fetch(`${origin}/mcp`);assert.equal(protectedResponse.status,401);assert.match(protectedResponse.headers.get("www-authenticate") ?? "",/oauth-protected-resource\/mcp/);
  const remote=new Client({name:"http-test",version:"1"});await remote.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?access=free`)));
  assert.ok((await remote.listTools()).tools.some(tool=>tool.name==="search"));
  assert.equal((await remote.callTool({name:"fetch",arguments:{id:"test"}})).isError,false);
  assert.equal((await remote.callTool({name:"academy_notes",arguments:{}})).isError,true);
  await remote.close();
});
