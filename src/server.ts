/** MCP metadata and execution are generated from the live Academy registry. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema,ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,type CallToolResult,McpError,ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { loadRegistry,toolsFor,executeOperation,readDocumentation,DOCUMENT_URIS,type CallIdentity,AcademyUnavailable,failure,validateToolCall } from "./academy-client.js";
import { isDocsTool } from "./core/docs-tools.js";
export const VERSION="0.6.0";
export interface ServerOptions {identity?:CallIdentity|null; mode?:"full"|"docs"}
export function createServer(options:ServerOptions={}):Server {
  const docs=options.mode==="docs";
  const identity=docs ? null : options.identity ?? null;
  const instructions=docs
    ? `StudioMeyer Academy documentation. Standard language: de; en and es are supported. Use search to find public content, then fetch with an id returned by search. This endpoint exposes only search and fetch. Use https://mcp.studiomeyer.academy/mcp?access=free for all public learning tools or https://mcp.studiomeyer.academy/mcp with OAuth for personal learning.`
    : `StudioMeyer Academy. Standard language: de; en and es are supported. Call academy_start to choose a learning path. Public lessons, library, search and fetch are freely readable. Connect https://mcp.studiomeyer.academy/mcp using OAuth to save progress, notes and quizzes and to read your credit balance and purchased content. Call academy_my_access after connecting to inspect your actual permissions. Credit spending is off by default and needs credits:spend plus the person's confirmation and a unique idempotencyKey for each action. Show the current price first. Certificates, XP, ranks and arena are dormant. Developer recipes and concepts are available on request. Use academy://docs/quickstart, academy://docs/errors and academy://docs/package-format for live documentation.`;
  const server=new Server({name:"mcp-academy",version:VERSION},{capabilities:{tools:{},resources:{}},instructions});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    try {
      const grant=identity?.revalidate ? await identity.revalidate() : identity?.grant ?? null;
      const tools=toolsFor(await loadRegistry(),grant);
      return {tools:docs ? tools.filter(tool=>isDocsTool(tool.name)) : tools};
    } catch(error) {
      throw new McpError(ErrorCode.InternalError,"Academy registry unavailable",error instanceof AcademyUnavailable ? error.envelope : failure("temporarily_unavailable",9002,"Authorization is unavailable.","Retry later."));
    }
  });
  server.setRequestHandler(CallToolRequestSchema,async(request):Promise<CallToolResult>=>{
    let envelope;
    try {
      if(docs && !isDocsTool(request.params.name)) {
        const input=request.params.arguments ?? {};
        const locale=input.locale==="en" || input.locale==="es" ? input.locale : "de";
        throw new McpError(ErrorCode.InvalidParams,"Unknown tool",failure("not_found",1101,"Unknown tool.","Use search and fetch on the documentation endpoint.",locale));
      }
      const registry=await loadRegistry(),input=request.params.arguments ?? {};
      const invalid=validateToolCall(registry,request.params.name,input);
      if(invalid)throw new McpError(ErrorCode.InvalidParams,invalid.errors[0].slug==="not_found"?"Unknown tool":"Invalid tool arguments",invalid);
      envelope=await executeOperation(registry,request.params.name,input,identity);
    }
    catch(error) {if(error instanceof McpError)throw error;envelope=error instanceof AcademyUnavailable ? error.envelope : failure("temporarily_unavailable",9002,"Academy service is unavailable.","Retry later.");}
    return {content:[{type:"text",text:JSON.stringify(envelope)}],structuredContent:envelope,isError:!envelope.success};
  });
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:DOCUMENT_URIS.map(uri=>({uri,name:uri.split("/").at(-1)!,mimeType:"text/markdown"}))}));
  server.setRequestHandler(ReadResourceRequestSchema,async request=>{
    try {return {contents:[{uri:request.params.uri,mimeType:"text/markdown",text:await readDocumentation(request.params.uri,await loadRegistry())}]};}
    catch(error) {throw new McpError(ErrorCode.InternalError,"Academy documentation unavailable",error instanceof AcademyUnavailable ? error.envelope : failure("temporarily_unavailable",9002,"Live documentation is unavailable.","Retry later."));}
  });
  return server;
}
