#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const wantHttp=process.argv.includes("--http") || process.env.MCP_TRANSPORT==="http" || (!!process.env.PORT && process.env.MCP_TRANSPORT!=="stdio");
async function main():Promise<void> {
  if(wantHttp) {const {startHttp}=await import("./http.js");await startHttp();return;}
  const offline=process.argv.includes("--offline") || process.env.ACADEMY_OFFLINE==="1";
  if(process.env.ACADEMY_API_KEY)process.stderr.write("[mcp-academy] Legacy ACADEMY_API_KEY does not grant OAuth rights. Connect the hosted OAuth endpoint for personal tools.\n");
  const server=offline ? (await import("./offline-server.js")).createOfflineServer() : (await import("./server.js")).createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[mcp-academy] stdio ${offline ? "explicit offline bundle" : "live public Academy"} ready\n`);
}
main().catch(error=>{process.stderr.write(`[mcp-academy] fatal: ${error instanceof Error ? error.message : "startup failed"}\n`);process.exitCode=1;});
