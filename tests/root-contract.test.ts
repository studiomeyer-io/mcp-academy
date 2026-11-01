import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer,VERSION } from "../src/server.js";
import { loadRegistry,toolsFor,executeOperation,readDocumentation,envelopeOutputSchema,failure,type Registry,type CallIdentity } from "../src/academy-client.js";
import { MCP_RESOURCE,REST_RESOURCE,type Grant } from "../src/auth/grants.js";
const index=JSON.parse(readFileSync(new URL("./root-api-index.fixture.json",import.meta.url),"utf8")) as Registry;
const aliasCases=JSON.parse(readFileSync(new URL("./root-alias-inputs.fixture.json",import.meta.url),"utf8")) as Array<{name:string;operation:string;input:Record<string,unknown>;normalized:Record<string,unknown>}>;
const ajv=new Ajv2020({strict:false});addFormats(ajv);
const grant:Grant={resource:MCP_RESOURCE,scopes:["learn:read","learn:write","credits:spend"],grant_version:2,consented_at:new Date()};
const identity=(selected:Grant=grant):CallIdentity=>({grant:selected,accessToken:"synthetic-root-user-token",revalidate:async()=>selected});
const success=(result:unknown)=>({success:true,result,errors:[],messages:[],request_id:"req_root_contract"});

test("actual imported Root index: public boundary, result unions, envelopes, transport fields and aliases",async t=>{
  assert.equal(index.operations.length,52);
  const access=index.operations.find(operation=>operation.id==="access")!;assert.equal(access.public,false);assert.deepEqual(access.requiredScopes,[]);
  const credits=index.operations.find(operation=>operation.id==="credits")!;assert.equal(credits.outputSchema.type,undefined);assert.ok(credits.outputSchema.anyOf);
  const previousBase=process.env.ACADEMY_BASE_URL,previousService=process.env.ACADEMY_MCP_SERVICE_TOKEN;
  process.env.ACADEMY_MCP_SERVICE_TOKEN="synthetic-root-service-token";
  const calls:Array<{body:{operation:string;input:Record<string,unknown>;locale:string};headers:Record<string,unknown>;method:string|undefined}> = [];
  let requireBrowserApproval=false;
  let resultMode:"unconfigured"|"configured"|"malformed"|"error"="unconfigured";
  const api=httpServer(async(req,res)=>{
    if(req.url==="/v1"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(success(index)));return;}
    if(req.url!=="/api/academy/execute"){res.setHeader("Content-Type","text/markdown");res.end(`# Root document ${req.url}`);return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString()) as {operation:string;input:Record<string,unknown>;locale:string};calls.push({body,headers:req.headers,method:req.method});
    const operation=index.operations.find(op=>op.id===body.operation)!;
    // Expected transformations were imported from Root's real normalizeLegacyInput.
    const alias=aliasCases.find(item=>item.operation===body.operation && JSON.stringify(item.input)===JSON.stringify(body.input));
    const normalized=alias?.normalized ?? body.input;
    res.setHeader("Content-Type","application/json");
    if(!ajv.validate(operation.inputSchema,normalized)){res.writeHead(400);res.end(JSON.stringify(failure("validation_failed",1100,"Invalid normalized input.","Use the schema.")));return;}
    let result:unknown;
    switch(body.operation){
      case "start": result={paths:[],links:[]};break;
      case "access":result={scopes:[],resource:MCP_RESOURCE,tools:["academy_my_access"],hint:"No optional scopes granted."};break;
      case "credits":
        if(resultMode==="error"){res.writeHead(409);res.end(JSON.stringify(failure("insufficient_credits",4002,"Not enough credits.","Read your balance.")));return;}
        result=resultMode==="malformed" ? {status:"configured",balances:"invalid"} : resultMode==="configured" ? {status:"configured",balances:[{source:"PURCHASED",credits:5}],spendingEnabled:false,purchasesEnabled:false} : {status:"unconfigured",bonusCredits:null,subscriptionCredits:null,euroValue:null,spendingEnabled:false,purchasesEnabled:false};break;
      case "quiz":result={slug:"synthetic-checkpoint",kind:"checkpoint",level:1,lessonSlug:null,locale:body.locale,title:"Synthetic checkpoint",description:null,passingScore:70,questions:[{id:"q1",text:"Question",options:[{id:"a",text:"Answer"}]}]};break;
      case "prepareSpend":result={id:"synthetic-quote",contentId:body.input.id ?? `${body.input.purpose}:synthetic`,contentVersion:"1",priceVersion:"1",credits:5,expiresAt:"2026-11-01T01:00:00Z"};break;
      case "premiumUnlock":if(requireBrowserApproval){res.writeHead(422);res.end(JSON.stringify(failure("confirmation_required",1106,"Stored browser approval required.","Approve this quote in the browser first.")));return;}result={entitlement:{contentId:"item",grantedAt:"2026-11-01T00:00:00Z",expiresAt:null},ledgerEntryId:"synthetic-ledger"};break;
      case "lessonDone":result={lessonId:"lesson:1:first-lesson",completedAt:"2026-11-01T00:00:00Z",firstCompletion:true};break;
      case "teach":result={id:"lesson:1:first-lesson",requestedLocale:body.locale,content_locale:body.locale,fallback:false,version:null,status:null,updated:null,content:{lessonId:"lesson:1:first-lesson",objectives:[],steps:[],exercise:"Read"}};break;
      case "legacyLevels":result={levels:[]};break;
      case "legacyLessons":result={lessons:[]};break;
      default:res.writeHead(501);res.end(JSON.stringify(failure("not_implemented",9001,"Fixture operation unavailable.","Choose a fixture operation.")));return;
    }
    res.end(JSON.stringify(success(result)));
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));process.env.ACADEMY_BASE_URL=`http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  t.after(async()=>{if(previousBase===undefined)delete process.env.ACADEMY_BASE_URL;else process.env.ACADEMY_BASE_URL=previousBase;if(previousService===undefined)delete process.env.ACADEMY_MCP_SERVICE_TOKEN;else process.env.ACADEMY_MCP_SERVICE_TOKEN=previousService;await new Promise<void>(resolve=>api.close(()=>resolve()));});
  const registry=await loadRegistry();assert.equal(registry.operations.length,52);
  const free=toolsFor(registry,null);assert.ok(!free.some(tool=>tool.name==="academy_my_access"));assert.ok(free.some(tool=>tool.name==="academy_levels"));
  assert.equal((await executeOperation(registry,"academy_my_access",{},null)).errors[0].slug,"auth_required");assert.equal(calls.length,0);
  const zeroGrant={...grant,scopes:[]};assert.ok(toolsFor(registry,zeroGrant).some(tool=>tool.name==="academy_my_access"));
  let revalidated=0;const zeroIdentity={...identity(zeroGrant),revalidate:async()=>{revalidated++;return zeroGrant;}};
  const accessResult=await executeOperation(registry,"academy_my_access",{},zeroIdentity);assert.equal(accessResult.success,true);assert.equal(revalidated,1);
  assert.equal(calls.at(-1)?.headers.authorization,"Bearer synthetic-root-user-token");assert.equal(calls.at(-1)?.headers["x-academy-service-authorization"],"Bearer synthetic-root-service-token");
  delete process.env.ACADEMY_MCP_SERVICE_TOKEN;const beforeMissing=calls.length;assert.equal((await executeOperation(registry,"academy_my_access",{},zeroIdentity)).errors[0].slug,"temporarily_unavailable");assert.equal(calls.length,beforeMissing);process.env.ACADEMY_MCP_SERVICE_TOKEN="synthetic-root-service-token";
  assert.equal((await executeOperation(registry,"academy_my_access",{},{...identity(),revalidate:async()=>null})).errors[0].slug,"auth_required");
  assert.equal((await executeOperation(registry,"academy_my_access",{},identity({...grant,resource:REST_RESOURCE}))).errors[0].slug,"invalid_token");

  const pair=InMemoryTransport.createLinkedPair();const server=createServer({identity:identity()});const client=new Client({name:"real-root-schema-client",version:"1"});await server.connect(pair[0]);await client.connect(pair[1]);t.after(async()=>{await client.close();await server.close();});
  assert.equal(client.getServerVersion()?.version,VERSION);assert.equal(VERSION,JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version);
  const listed=await client.listTools();const creditTool=listed.tools.find(tool=>tool.name==="academy_credits")!;assert.equal(creditTool.outputSchema?.type,"object");assert.ok(creditTool.outputSchema?.oneOf);assert.ok(creditTool.inputSchema.properties?.locale);assert.ok(creditTool.inputSchema.properties?.idempotencyKey);
  for(const mode of ["unconfigured","configured"] as const){resultMode=mode;const result=await client.callTool({name:"academy_credits",arguments:{locale:"en"}});assert.equal(result.isError,false);assert.equal((result.structuredContent as {result:{status:string}}).result.status,mode);assert.ok(ajv.validate(creditTool.outputSchema!,result.structuredContent));}
  resultMode="error";const domainError=await client.callTool({name:"academy_credits",arguments:{}});assert.equal(domainError.isError,true);assert.equal((domainError.structuredContent as {errors:Array<{slug:string}>}).errors[0].slug,"insufficient_credits");assert.ok(ajv.validate(creditTool.outputSchema!,domainError.structuredContent));
  resultMode="malformed";const malformed=await client.callTool({name:"academy_credits",arguments:{}});assert.equal(malformed.isError,true);assert.equal((malformed.structuredContent as {errors:Array<{slug:string}>}).errors[0].slug,"temporarily_unavailable");
  for(const locale of ["de","en","es"]){const result=await client.callTool({name:"academy_start",arguments:{locale}});assert.equal(result.isError,false);assert.equal(calls.at(-1)?.body.locale,locale);assert.deepEqual(calls.at(-1)?.body.input,{});}
  const prepare=index.operations.find(operation=>operation.id==="prepareSpend")!;
  const branches=prepare.inputSchema.oneOf ?? prepare.inputSchema.anyOf;assert.ok(Array.isArray(branches));
  const examples=[{purpose:"PREMIUM",id:"item"},{purpose:"TUTOR",level:1,slug:"first-lesson",message:"Help me understand"},{purpose:"COACHING",topic:"Learn AI",format:"individual",preferredTime:"afternoon"}];
  for(const keyword of ["oneOf","anyOf"] as const) {
    const alternateInput={...prepare.inputSchema};delete alternateInput.oneOf;delete alternateInput.anyOf;alternateInput[keyword]=branches;
    const generated=toolsFor({...index,operations:[{...prepare,inputSchema:alternateInput}]},grant)[0];
    for(const example of examples)assert.ok(ajv.validate(generated.inputSchema,{...example,locale:"es",idempotencyKey:"quote-preparation"}),`${keyword}: ${JSON.stringify(ajv.errors)}`);
    assert.equal(ajv.validate(generated.inputSchema,{purpose:"PREMIUM",id:"item",locale:"de",idempotencyKey:"quote-preparation",untrustedExtra:true}),false);
    assert.equal(ajv.validate(generated.inputSchema,{purpose:"PREMIUM",id:"item",topic:"Wrong branch",locale:"de"}),false);
  }
  assert.equal((branches[0] as {properties:Record<string,unknown>}).properties.locale,undefined,"Root service schema must remain untouched");
  for(const [position,example] of examples.entries()) {
    const locale=["de","en","es"][position];const args={...example,locale,idempotencyKey:`prepare-quote-${position}`};
    const quoted=await client.callTool({name:"academy_prepare_spend",arguments:args});assert.equal(quoted.isError,false);
    assert.equal(calls.at(-1)?.method,"POST");assert.deepEqual(calls.at(-1)?.body.input,example);assert.equal(calls.at(-1)?.body.locale,locale);assert.equal(calls.at(-1)?.headers["idempotency-key"],args.idempotencyKey);assert.equal(calls.at(-1)?.headers.authorization,"Bearer synthetic-root-user-token");
    assert.equal((quoted.structuredContent as {result:{id:string}}).result.id,"synthetic-quote");
  }
  const spending={id:"item",consent:{userConfirmed:true,quoteId:"quote_example",maximumCredits:5},idempotencyKey:"synthetic-spend-key",locale:"es"};
  const unlocked=await client.callTool({name:"academy_premium_unlock",arguments:spending});assert.equal(unlocked.isError,false);assert.deepEqual(calls.at(-1)?.body.input,{id:spending.id,consent:spending.consent});assert.equal(calls.at(-1)?.body.locale,"es");assert.equal(calls.at(-1)?.headers["idempotency-key"],"synthetic-spend-key");
  requireBrowserApproval=true;const beforeApproval=calls.length;
  const unapproved=await client.callTool({name:"academy_premium_unlock",arguments:{...spending,idempotencyKey:"requires-browser-approval"}});assert.equal(unapproved.isError,true);assert.equal((unapproved.structuredContent as {errors:Array<{slug:string}>}).errors[0].slug,"confirmation_required");assert.equal(calls.length,beforeApproval+1,"Stored browser approval is decided by Academy, not a flat MCP boolean");
  assert.equal((await executeOperation(registry,"academy_premium_unlock",spending,identity({...grant,scopes:["learn:read"]}))).errors[0].slug,"credits_spend_not_granted");
  assert.equal((await executeOperation(registry,"academy_tutor",{},identity({...grant,scopes:["credits:spend"]}))).errors[0].slug,"insufficient_scope");
  const beforeInvalid=calls.length;assert.equal((await executeOperation(registry,"academy_premium_unlock",{id:"item",userConfirmed:true,idempotencyKey:"flat-confirmation"},identity())).errors[0].slug,"validation_failed");assert.equal(calls.length,beforeInvalid);
  for(const item of aliasCases){const result=await client.callTool({name:item.name,arguments:{...item.input,locale:"de"}});assert.equal(result.isError,false,item.name);assert.deepEqual(calls.at(-1)?.body.input,item.input);}
  const beforeCanonical=calls.length;assert.equal((await executeOperation(registry,"academy_lesson_done",{level:1,lessonSlug:"first-lesson"},identity())).errors[0].slug,"validation_failed");assert.equal(calls.length,beforeCanonical);
  const invalidAlias=await executeOperation(registry,"academy_progress_complete",{level:1,lessonSlug:"first-lesson",untrustedExtra:true},identity());assert.equal(invalidAlias.errors[0].slug,"validation_failed");assert.equal(calls.length,beforeCanonical+1);
  for(const input of [{slug:"synthetic-checkpoint"},{quizSlug:"synthetic-checkpoint"},{level:1,slug:"first-lesson"}]) {
    const quizRead=await client.callTool({name:"academy_quiz",arguments:{...input,locale:"es"}});
    assert.equal(quizRead.isError,false);assert.equal((quizRead.structuredContent as {result:{slug:string}}).result.slug,"synthetic-checkpoint");
    assert.deepEqual(calls.at(-1)?.body.input,input);assert.equal(calls.at(-1)?.body.locale,"es");
    assert.equal(JSON.stringify(quizRead.structuredContent).includes('"correct"'),false);
  }
  assert.equal((await executeOperation(registry,"academy_quiz",{slug:"synthetic-checkpoint",userId:"untrusted-extra"},identity())).errors[0].slug,"validation_failed");
  assert.match(await readDocumentation("academy://docs/quickstart",registry),/\/quickstart.md/);assert.match(await readDocumentation("academy://docs/errors",registry),/\/v1\/errors/);assert.match(await readDocumentation("academy://docs/package-format",registry),/\/entwickler\/paketformat.md/);
  await assert.rejects(readDocumentation("https://example.com/academy://docs/quickstart",registry),/Unknown documentation/);await assert.rejects(readDocumentation("academy://docs/quickstart?ref=anything",registry),/Unknown documentation/);
  assert.ok(ajv.validate(envelopeOutputSchema(credits.outputSchema),domainError.structuredContent));
});
