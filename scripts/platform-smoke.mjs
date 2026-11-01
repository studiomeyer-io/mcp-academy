#!/usr/bin/env node
/** Built CLI smoke: live default stdio and explicit legacy offline library. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let reads=0;
const inputSchema={type:'object',properties:{locale:{enum:['de','en','es']},query:{type:'string'},id:{type:'string'}},additionalProperties:false};
const outputSchema={type:'object',required:['operation','locale','source'],properties:{operation:{type:'string'},locale:{type:'string'},source:{const:'live-mock'}},additionalProperties:false};
const envelope=result=>({success:true,result,errors:[],messages:[],request_id:'req_built_smoke'});
const api=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1'){reads++;res.end(JSON.stringify(envelope({operations:[{id:'start',description:'Live start',rest:[],mcp:{names:['academy_start','search','fetch'],deprecatedAliases:['academy_welcome'],annotations:{readOnlyHint:true}},inputSchema,outputSchema,requiredScopes:[],public:true,creditEffect:'none'}]})));return;}
  if(req.url==='/api/academy/execute'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const call=JSON.parse(Buffer.concat(chunks));res.end(JSON.stringify(envelope({locale:call.locale,source:'live-mock',operation:call.operation})));return;}
  res.writeHead(404);res.end();
});
await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
const clients=[];
try{
  const env=Object.fromEntries(Object.entries(process.env).filter(([,value])=>value!==undefined));
  env.ACADEMY_BASE_URL=`http://127.0.0.1:${api.address().port}`;
  env.MCP_TRANSPORT='stdio';delete env.ACADEMY_OFFLINE;delete env.ACADEMY_API_KEY;
  const live=new Client({name:'built-live-smoke',version:'1'});clients.push(live);
  await live.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env}));
  assert.match(live.getInstructions(),/Standard language: de/);
  assert.equal(live.getServerVersion().version,"0.5.0");
  const listed=await live.listTools();assert.deepEqual(listed.tools.map(tool=>tool.name),['academy_start','search','fetch','academy_welcome']);
  for(const [name,args] of [['academy_start',{}],['search',{query:'test'}],['fetch',{id:'test'}]]){
    const result=await live.callTool({name,arguments:args});assert.equal(result.isError,false);assert.equal(result.structuredContent.result.source,'live-mock');assert.equal(result.structuredContent.result.locale,'de');
  }
  const privateCall=await live.callTool({name:'academy_notes',arguments:{}});assert.equal(privateCall.isError,true);
  assert.ok(reads>=5,'registry must be read from Academy at runtime');
  const offline=new Client({name:'built-offline-smoke',version:'1'});clients.push(offline);
  await offline.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js','--offline'],env}));
  assert.match(offline.getInstructions(),/Legacy offline curriculum snapshot/);
  assert.ok((await offline.listTools()).tools.some(tool=>tool.name==='academy_levels'));
  const levels=await offline.callTool({name:'academy_levels',arguments:{locale:'de'}});assert.ok(JSON.parse(levels.content[0].text).levels.length>0);
  assert.equal((await offline.callTool({name:'academy_note_save',arguments:{}})).isError,true);
  console.log('PASS: built default stdio uses live registry/content, public search/fetch execute, private calls deny, explicit offline snapshot remains readable.');
}finally{
  await Promise.all(clients.map(client=>client.close()));
  await new Promise(resolve=>api.close(resolve));
}
