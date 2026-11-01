/** Explicit opt-in legacy bundle. Never used by hosted or default stdio MCP. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema,ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PUBLIC_TOOLS,handlePublicTool } from "./public-tools.js";
import { VERSION } from "./server.js";
export function createOfflineServer():Server {
  const server=new Server({name:"mcp-academy-offline",version:VERSION},{capabilities:{tools:{}},instructions:"Legacy offline curriculum snapshot. It can be outdated. Use the live Academy MCP for current paths and personal learning. No account or credit operations are available in this mode."});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:PUBLIC_TOOLS.map(tool=>({...tool,annotations:{readOnlyHint:true}}))}));
  server.setRequestHandler(CallToolRequestSchema,async request=>await handlePublicTool(request.params.name,request.params.arguments ?? {}) ?? {content:[{type:"text",text:"Unknown offline tool"}],isError:true});
  return server;
}
