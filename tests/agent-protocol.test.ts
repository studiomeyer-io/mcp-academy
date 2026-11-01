import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcp } from "../src/http.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer,VERSION } from "../src/server.js";
import { createOfflineServer } from "../src/offline-server.js";
import { toolsFor,failure,type Registry } from "../src/academy-client.js";
const read=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),"utf8"));
const fixture=read("./root-api-index.fixture.json") as Registry;
function noExternalRefs(value:unknown):void {
  if(Array.isArray(value)){value.forEach(noExternalRefs);return;}
  if(!value||typeof value!=="object")return;
  for(const [key,v] of Object.entries(value)){if(key==="$ref"||key==="$dynamicRef")assert.ok(typeof v==="string"&&v.startsWith("#/"),`Nonlocal schema reference: ${v}`);else noExternalRefs(v);}
}
test("official Agent Plugins 1.0.0 schemas, transport and actual versions agree",()=>{
  const ajv=new Ajv2020({strict:false});addFormats(ajv);
  for(const name of ["plugin","mcp"]) {const schema=read(`./schemas/agent-plugins-${name}-1.0.0.json`),manifest=read(`../${name}.json`);assert.equal(ajv.validate(schema,manifest),true,JSON.stringify(ajv.errors));}
  assert.equal(read("../plugin.json").version,VERSION);assert.equal(read("../package.json").version,VERSION);assert.equal(read("../server.json").version,VERSION);
  assert.equal(read("../mcp.json").mcpServers.academy.type,"streamable-http");
  assert.equal(read("../mcp.json").mcpServers.academy.url,"https://mcp.studiomeyer.academy/mcp");
});
test("all public and personal output schemas are self-contained and compile using actual MCP SDK validator",()=>{
  const ajv=new Ajv2020({strict:false});addFormats(ajv);const validator=new AjvJsonSchemaValidator(ajv);
  const tools=toolsFor(fixture,{scopes:["learn:read","learn:write","credits:spend"],resource:"https://mcp.studiomeyer.academy/mcp",grant_version:2,consented_at:new Date()});
  assert.equal(tools.length,56);assert.equal(toolsFor(fixture,null).length,29);
  for(const tool of tools){assert.ok(tool.outputSchema);noExternalRefs(tool.outputSchema);const validate=validator.getValidator(tool.outputSchema);assert.equal(validate(failure("payment_required",4001,"Payment required.","Review the paywall.")).valid,true,tool.name);}
});
test("real SDK returns protocol errors for malformed calls and preserves execution paywalls",async t=>{
  const paywall=failure("payment_required",4001,"Payment required.","Ask the human to review the offer.","en");let executes=0;
  const api=httpServer(async(req,res)=>{res.setHeader("Content-Type","application/json");if(req.url==="/v1"){res.end(JSON.stringify({success:true,result:fixture,errors:[],messages:[],request_id:"synthetic"}));return;}executes++;res.writeHead(402);res.end(JSON.stringify(paywall));});
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));const old=process.env.ACADEMY_BASE_URL;process.env.ACADEMY_BASE_URL=`http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  t.after(async()=>{if(old===undefined)delete process.env.ACADEMY_BASE_URL;else process.env.ACADEMY_BASE_URL=old;await new Promise<void>(resolve=>api.close(()=>resolve()));});
  const hosted=httpServer((req,res)=>{void handleMcp(req,res).catch(()=>res.writeHead(503).end());});await new Promise<void>(resolve=>hosted.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise<void>(resolve=>hosted.close(()=>resolve())));
  const remote=new Client({name:"actual-http-protocol-test",version:"1"});await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(hosted.address() as AddressInfo).port}/mcp?access=free`)));
  try {
    for(const call of [{name:"unknown_tool",arguments:{locale:"es"}},{name:"academy_lesson",arguments:{slug:12345}}])await assert.rejects(remote.callTool(call),error=>{assert.ok(error&&typeof error==="object"&&"code" in error&&"data" in error);assert.equal(error.code,-32602);assert.ok((error.data as ReturnType<typeof failure>).request_id);return true;});
    assert.equal(executes,0);
  }finally{await remote.close();}
  for(const offline of [false,true]) {
    const server=offline?createOfflineServer():createServer(),pair=InMemoryTransport.createLinkedPair(),client=new Client({name:"protocol-test",version:"1"});await server.connect(pair[0]);await client.connect(pair[1]);
    try {
      for(const call of [{name:"unknown_tool",arguments:{locale:"es"}},{name:"academy_lesson",arguments:{slug:12345}},{name:"academy_lesson",arguments:{}}]) {
        await assert.rejects(client.callTool(call),error=>{assert.ok(error&&typeof error==="object"&&"code" in error&&"message" in error&&"data" in error);assert.equal(error.code,-32602);assert.match(String(error.message),/Unknown tool|Invalid tool arguments/);const data=error.data as ReturnType<typeof failure>;assert.equal(data.success,false);assert.ok(data.request_id);assert.ok([1100,1101].includes(data.errors[0].code));return true;});
      }
      if(!offline){assert.equal(executes,0);const result=await client.callTool({name:"academy_start",arguments:{locale:"en"}});assert.equal(result.isError,true);assert.deepEqual(result.structuredContent,paywall);assert.equal(executes,1);}
    }finally{await client.close();await server.close();}
  }
});
