/** Explicit opt-in legacy bundle. Never used by hosted or default stdio MCP. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema,ListToolsRequestSchema,McpError,ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { PUBLIC_TOOLS,handlePublicTool } from "./public-tools.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { failure } from "./academy-client.js";
import { VERSION } from "./server.js";
export function createOfflineServer():Server {
  const server=new Server({name:"mcp-academy-offline",version:VERSION},{capabilities:{tools:{}},instructions:"Legacy offline curriculum snapshot. It can be outdated. Use the live Academy MCP for current paths and personal learning. No account or credit operations are available in this mode."});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:PUBLIC_TOOLS.map(tool=>({...tool,annotations:{readOnlyHint:true}}))}));
  const validator=new AjvJsonSchemaValidator();
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const input=request.params.arguments??{},tool=PUBLIC_TOOLS.find(t=>t.name===request.params.name);
    const locale=input.locale==="en"||input.locale==="es"?input.locale:"de";
    if(!tool || !validator.getValidator(tool.inputSchema)(input).valid) {
      const envelope=failure(tool?"validation_failed":"not_found",tool?1100:1101,tool?"Invalid tool arguments.":"Unknown tool.","Read tools/list and use the declared fields and types.",locale);
      throw new McpError(ErrorCode.InvalidParams,tool?"Invalid tool arguments":"Unknown tool",envelope);
    }
    return await handlePublicTool(request.params.name,input) ?? {content:[{type:"text",text:JSON.stringify(failure("not_found",1101,"Content not found.","Search the offline library.",locale))}],isError:true};
  });
  return server;
}
