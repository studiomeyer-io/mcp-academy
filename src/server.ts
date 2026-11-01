/** MCP metadata and execution are generated from the live Academy registry. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema,ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,type CallToolResult,McpError,ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { loadRegistry,toolsFor,executeOperation,readDocumentation,DOCUMENT_URIS,type CallIdentity,AcademyUnavailable,failure } from "./academy-client.js";
export const VERSION="0.5.0";
export interface ServerOptions {identity?:CallIdentity|null}
export function createServer(options:ServerOptions={}):Server {
  const identity=options.identity ?? null;
  const instructions=`StudioMeyer Academy. Standard language: de; en and es are supported. Call academy_start to choose a learning path. Public lessons, library, search and fetch are freely readable. Connect https://mcp.studiomeyer.academy/mcp using OAuth to save progress, notes and quizzes and to read your credit balance and purchased content. Call academy_my_access after connecting to inspect your actual permissions. Credit spending is off by default and needs credits:spend plus the person's confirmation and a unique idempotencyKey for each action. Show the current price first. Certificates, XP, ranks and arena are dormant. Developer recipes and concepts are available on request. Use academy://docs/quickstart, academy://docs/errors and academy://docs/package-format for live documentation.`;
  const server=new Server({name:"mcp-academy",version:VERSION},{capabilities:{tools:{},resources:{}},instructions});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    try {
      const grant=identity?.revalidate ? await identity.revalidate() : identity?.grant ?? null;
      return {tools:toolsFor(await loadRegistry(),grant)};
    } catch(error) {
      throw new McpError(ErrorCode.InternalError,"Academy registry unavailable",error instanceof AcademyUnavailable ? error.envelope : failure("temporarily_unavailable",9002,"Authorization is unavailable.","Retry later."));
    }
  });
  server.setRequestHandler(CallToolRequestSchema,async(request):Promise<CallToolResult>=>{
    let envelope;
    try {envelope=await executeOperation(await loadRegistry(),request.params.name,request.params.arguments ?? {},identity);}
    catch(error) {envelope=error instanceof AcademyUnavailable ? error.envelope : failure("temporarily_unavailable",9002,"Academy service is unavailable.","Retry later.");}
    return {content:[{type:"text",text:JSON.stringify(envelope)}],structuredContent:envelope,isError:!envelope.success};
  });
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:DOCUMENT_URIS.map(uri=>({uri,name:uri.split("/").at(-1)!,mimeType:"text/markdown"}))}));
  server.setRequestHandler(ReadResourceRequestSchema,async request=>{
    try {return {contents:[{uri:request.params.uri,mimeType:"text/markdown",text:await readDocumentation(request.params.uri,await loadRegistry())}]};}
    catch(error) {throw new McpError(ErrorCode.InternalError,"Academy documentation unavailable",error instanceof AcademyUnavailable ? error.envelope : failure("temporarily_unavailable",9002,"Live documentation is unavailable.","Retry later."));}
  });
  return server;
}
