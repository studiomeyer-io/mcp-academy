import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleMcp } from "../src/http.js";
import { createServer } from "../src/server.js";
import { DOCS_TOOL_NAMES } from "../src/core/docs-tools.js";
import { toolsFor, type Registry, type Envelope } from "../src/academy-client.js";
import { MCP_RESOURCE, type Grant } from "../src/auth/grants.js";

const fixture=JSON.parse(readFileSync(new URL("./root-api-index.fixture.json",import.meta.url),"utf8")) as Registry;

test("docs endpoint restricts listing and direct execution while free and OAuth contracts remain intact",{timeout:20000},async t=>{
  const executionCalls:Array<{operation:string;input:Record<string,unknown>;locale:string}>=[];
  const outputs:Record<string,unknown>={
    search:{items:[{id:"prompt:synthetic",type:"prompt",title:"Synthetic prompt",description:"Synthetic public prompt",href:"/synthetic",access:"free",creditPrice:null,euroPrice:null,categories:[],locale:"es",contentLocale:"es",translationPending:false,source:{kind:"playbook",slug:"synthetic",href:"/synthetic",label:"Synthetic"}}],nextCursor:null},
    fetch:{id:"prompt:synthetic",requestedLocale:"es",content_locale:"es",fallback:false,version:"1",status:"active",updated:null,content:{id:"synthetic",text:"Synthetic public content",playbookId:null}},
  };
  const api=httpServer(async(req,res)=>{
    res.setHeader("Content-Type","application/json");
    if(req.url==="/v1") {res.end(JSON.stringify({success:true,result:fixture,errors:[],messages:[],request_id:"req_registry"}));return;}
    assert.equal(req.url,"/api/academy/execute");
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString()) as typeof executionCalls[number];
    executionCalls.push(body);
    assert.equal(req.headers.authorization,undefined);
    assert.equal(req.headers["x-academy-service-authorization"],undefined);
    res.end(JSON.stringify({success:true,result:outputs[body.operation],errors:[],messages:[],request_id:"req_content"}));
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
  const oldBase=process.env.ACADEMY_BASE_URL;
  process.env.ACADEMY_BASE_URL=`http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  t.after(async()=>{if(oldBase===undefined)delete process.env.ACADEMY_BASE_URL;else process.env.ACADEMY_BASE_URL=oldBase;api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));});
  const hosted=httpServer((req,res)=>{void handleMcp(req,res).catch(()=>res.writeHead(503).end());});
  await new Promise<void>(resolve=>hosted.listen(0,"127.0.0.1",resolve));
  t.after(()=>{hosted.closeAllConnections();return new Promise<void>(resolve=>hosted.close(()=>resolve()));});
  const origin=`http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
  for(const suffix of ["","?access=unknown"])assert.equal((await fetch(`${origin}/mcp${suffix}`)).status,401);
  const connect=async(access:string)=>{
    const client=new Client({name:`docs-test-${access}`,version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?access=${access}`)));
    t.after(()=>client.close());return client;
  };
  const docs=await connect("docs"),free=await connect("free");
  assert.deepEqual((await docs.listTools()).tools.map(tool=>tool.name).sort(),[...DOCS_TOOL_NAMES].sort());
  assert.deepEqual((await free.listTools()).tools.map(tool=>tool.name),toolsFor(fixture,null).map(tool=>tool.name));
  assert.match(docs.getInstructions()??"",/only search and fetch/);
  for(const name of ["academy_start","academy_legacy_levels","academy_notes"]) {
    await assert.rejects(docs.callTool({name,arguments:{locale:"en"}}),error=>{
      assert.ok(error&&typeof error==="object"&&"code" in error&&"data" in error);
      assert.equal(error.code,-32602);assert.equal((error.data as Envelope).errors[0].slug,"not_found");return true;
    });
  }
  assert.equal(executionCalls.length,0,"hidden public, alias and personal tools must never execute");
  const found=await docs.callTool({name:"search",arguments:{query:"synthetic",locale:"es"}});
  assert.equal(found.isError,false);
  const id=(found.structuredContent as {result:{items:Array<{id:string}>}}).result.items[0].id;
  const docsFetch=await docs.callTool({name:"fetch",arguments:{id,locale:"es"}});
  const freeFetch=await free.callTool({name:"fetch",arguments:{id,locale:"es"}});
  assert.equal(docsFetch.isError,false);assert.deepEqual(docsFetch,freeFetch);
  assert.ok(executionCalls.every(call=>call.locale==="es"));
  await assert.rejects(docs.callTool({name:"search",arguments:{query:123}}),error=>!!(error&&typeof error==="object"&&"code" in error&&error.code===-32602));
  assert.equal(executionCalls.length,3);

  const grant:Grant={scopes:["learn:read"],resource:MCP_RESOURCE,grant_version:2,consented_at:new Date()};
  for(const mode of ["full","docs"] as const) {
    let revalidated=0;
    const server=createServer({mode,identity:{grant,accessToken:"synthetic-unused",revalidate:async()=>{revalidated++;return grant;}}});
    const pair=InMemoryTransport.createLinkedPair(),client=new Client({name:`identity-${mode}`,version:"1"});
    await server.connect(pair[0]);await client.connect(pair[1]);
    try {
      const names=(await client.listTools()).tools.map(tool=>tool.name);
      assert.deepEqual(names,mode==="docs" ? toolsFor(fixture,null).filter(tool=>DOCS_TOOL_NAMES.some(name=>name===tool.name)).map(tool=>tool.name) : toolsFor(fixture,grant).map(tool=>tool.name));
      assert.equal(revalidated,mode==="docs"?0:1,"docs mode must ignore any injected personal identity");
      if(mode==="docs") {
        const before=executionCalls.length;
        for(const name of toolsFor(fixture,{...grant,scopes:["learn:read","learn:write","credits:spend"]}).map(tool=>tool.name).filter(name=>!DOCS_TOOL_NAMES.some(allowed=>allowed===name))) {
          await assert.rejects(client.callTool({name,arguments:{locale:"es"}}),error=>!!(error&&typeof error==="object"&&"code" in error&&"data" in error&&error.code===-32602&&(error.data as Envelope).errors[0].slug==="not_found"));
        }
        assert.equal(executionCalls.length,before,"every hidden tool must deny execution without calling Academy");
      }
    }finally{await client.close();await server.close();}
  }
});
