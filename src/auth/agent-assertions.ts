/** Only our own service assertions are accepted. External identity issuers are not enabled. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getBaseUrl } from "../core/base-url.js";
import { MCP_RESOURCE } from "./grants.js";
export const ASSERTION_GRANT="urn:ietf:params:oauth:grant-type:jwt-bearer";
export const CLAIM_GRANT="urn:workos:agent-auth:grant-type:claim";
export function agentIdentityEnabled():boolean {
  const secret=process.env.ACADEMY_AGENT_ASSERTION_SECRET;
  return typeof secret==="string" && Buffer.byteLength(secret)>=32;
}
function secret():string {
  if(!agentIdentityEnabled())throw new Error("Agent identity signing unavailable");
  return process.env.ACADEMY_AGENT_ASSERTION_SECRET!;
}
export interface AgentAssertion {iss:string;aud:string;sub:string;version:number;iat:number;exp:number;jti:string;email?:string;email_verified?:true;}
export function signAgentAssertion(id:string,version:number,expires:Date,email?:string):{identity_assertion:string;assertion_expires:string} {
  const now=Math.floor(Date.now()/1000),exp=Math.min(now+3600,Math.floor(expires.getTime()/1000));
  const payload:AgentAssertion={iss:getBaseUrl(),aud:MCP_RESOURCE,sub:id,version,iat:now,exp,jti:randomUUID(),...(version===2&&email?{email,email_verified:true as const}:{})};
  const signing=[{alg:"HS256",typ:"JWT"},payload].map(v=>Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
  return {identity_assertion:`${signing}.${createHmac("sha256",secret()).update(signing).digest("base64url")}`,assertion_expires:new Date(exp*1000).toISOString()};
}
export function verifyAgentAssertion(raw:string):AgentAssertion|null {
  try {
    if(raw.length>4096)return null;
    const parts=raw.split(".");if(parts.length!==3 || parts.some(p=>! /^[A-Za-z0-9_-]+$/.test(p)))return null;
    const expected=createHmac("sha256",secret()).update(`${parts[0]}.${parts[1]}`).digest(),actual=Buffer.from(parts[2],"base64url");
    if(expected.length!==actual.length || !timingSafeEqual(expected,actual))return null;
    const header:unknown=JSON.parse(Buffer.from(parts[0],"base64url").toString()),value:unknown=JSON.parse(Buffer.from(parts[1],"base64url").toString());
    if(!header || typeof header!=="object" || !("alg" in header) || header.alg!=="HS256" || !("typ" in header)||header.typ!=="JWT")return null;
    if(!value || typeof value!=="object")return null;
    const p=value as Partial<AgentAssertion>,now=Math.floor(Date.now()/1000);
    if(p.iss!==getBaseUrl() || p.aud!==MCP_RESOURCE || typeof p.sub!=="string" || !/^reg_[A-Za-z0-9_-]{43}$/.test(p.sub) || ![1,2].includes(p.version??0) || !Number.isInteger(p.exp) || p.exp!<=now || !Number.isInteger(p.iat) || p.iat!>now+30 || p.exp!-p.iat!>3600 || typeof p.jti!=="string")return null;
    if(p.version===2&&(typeof p.email!=="string"||p.email_verified!==true))return null;
    return p as AgentAssertion;
  } catch{return null;}
}
export function agentAuthMetadata() {
  return agentIdentityEnabled()?{skill:"https://studiomeyer.academy/auth.md",identity_endpoint:`${getBaseUrl()}/agent/identity`,claim_endpoint:`${getBaseUrl()}/agent/identity/claim`,identity_types_supported:["anonymous"]}:undefined;
}
