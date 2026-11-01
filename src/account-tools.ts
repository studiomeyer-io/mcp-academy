/** Compatibility facade. Tool definitions and legacy aliases come from Academy. */
import { executeOperation,loadRegistry,toolsFor,failure } from "./academy-client.js";
import type { ToolResult } from "./public-tools.js";
/** Legacy email/API-key values deliberately carry no authority. */
export type BridgeAuth =
  | {kind:"api_key";apiKey:string}
  | {kind:"oauth";email?:string;accessToken?:string};
export async function handleAccountTool(auth:BridgeAuth,name:string,args:Record<string,unknown>):Promise<ToolResult|null> {
  const {authenticateBearer}=await import("./auth/oauth-persistence.js");
  const principal=auth.kind==="oauth" && auth.accessToken ? await authenticateBearer(auth.accessToken) : null;
  const registry=await loadRegistry();
  if(!registry.operations.some(operation=>operation.mcp && [...operation.mcp.names,...operation.mcp.deprecatedAliases].includes(name)))return null;
  const envelope=principal
    ? await executeOperation(registry,name,args,{grant:principal,accessToken:principal.accessToken,revalidate:()=>authenticateBearer(principal.accessToken)})
    : failure("auth_required",1000,"This operation needs OAuth authorization.","Connect the hosted Academy MCP with OAuth; legacy API keys and email claims grant no rights.");
  return {content:[{type:"text",text:JSON.stringify(envelope)}],structuredContent:envelope,isError:!envelope.success};
}
export async function loadAccountTools(accessToken:string) {
  const {authenticateBearer}=await import("./auth/oauth-persistence.js");
  const grant=await authenticateBearer(accessToken);
  const registry=await loadRegistry();
  const privateNames=new Set(registry.operations.filter(operation=>operation.public===false).flatMap(operation=>operation.mcp ? [...operation.mcp.names,...operation.mcp.deprecatedAliases] : []));
  return toolsFor(registry,grant).filter(tool=>privateNames.has(tool.name));
}
