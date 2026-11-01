import { agentAuthMetadata,agentIdentityEnabled,ASSERTION_GRANT,CLAIM_GRANT } from "./agent-assertions.js";
import { handleAgentIdentity } from "./agent-identity.js";
import { AgentIdentityError,exchangeAgentAssertion,pollAgentClaim,revokeAgentAccess,cleanupAgentIdentities } from "./agent-identity-store.js";
/** OAuth 2.1 public clients, S256 PKCE, browser-bound consent, DB-authoritative grants. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getBaseUrl } from "../core/base-url.js";
import { clientIp as resolveClientIp } from "../core/client-ip.js";
import { getDb } from "../db.js";
import { checkIpRateLimit, checkMagicLinkMailBudget } from "../safety/rate-limit.js";
import { hashToken } from "./token-hash.js";
import { SCOPES, MCP_RESOURCE, resourceAllowed, parseScopes, type Scope } from "./grants.js";
import { randomToken, saveClient, getClient, saveAuthorization, consumeAuthorization, saveMagicLink, consumeMagicLink, saveAuthCode, redeemCode, rotateRefresh, revokeToken, authenticateBearer, cleanupExpiredOAuthState, type Authorization } from "./oauth-persistence.js";
import { sendMagicLinkEmail } from "./email-magic.js";
import { normalizeEmail, isValidEmail, isUserAllowed } from "./users.js";
import { brandedPageShell, escHtml as esc } from "./page-shell.js";
import { detectLocale, type Locale } from "./i18n.js";
import { enabledProviders, isProvider, isProviderEnabled, createProviderState, consumeProviderState, buildProviderAuthorizeUrl, exchangeProviderCode, fetchProviderProfile, cleanupExpiredProviderStates } from "./social-providers.js";

export const clientIp = resolveClientIp;
const COOKIE = "academy_oauth_browser";
const MAX_BODY = 65536;
const TEXT = {
  de: {title:"Academy verbinden",intro:"Wähle, was diese KI für dich tun darf. Öffentliche Inhalte sind ohne Anmeldung frei lesbar.",read:"Deinen Lernstand, Notizen und gekaufte Inhalte lesen",write:"Fortschritt, Notizen und Quiz speichern",spend:"Credits ausgeben: zusätzlich ist für jeden Vorgang deine Bestätigung nötig",email:"E-Mail",send:"Anmeldelink senden",sent:"Wenn die Anmeldung möglich ist, erhältst du einen Link per E-Mail. Öffne ihn in diesem Browser.",invalid:"Diese Anmeldung ist abgelaufen oder gehört zu einem anderen Browser. Verbinde die Academy erneut.",privacy:"Datenschutz",permission:"Berechtigungen",provider:"Weiter mit"},
  en: {title:"Connect Academy",intro:"Choose what this AI may do for you. Public content is freely readable without signing in.",read:"Read your learning progress, notes and purchased content",write:"Save progress, notes and quizzes",spend:"Spend credits: your confirmation is also required for each action",email:"Email",send:"Send sign-in link",sent:"If sign-in is available, you will receive an email link. Open it in this browser.",invalid:"This sign-in expired or belongs to another browser. Connect Academy again.",privacy:"Privacy",permission:"Permissions",provider:"Continue with"},
  es: {title:"Conectar Academy",intro:"Elige qué puede hacer esta IA por ti. El contenido público se puede leer sin iniciar sesión.",read:"Leer tu progreso, notas y contenido comprado",write:"Guardar progreso, notas y cuestionarios",spend:"Gastar créditos: cada operación también necesita tu confirmación",email:"Correo electrónico",send:"Enviar enlace de acceso",sent:"Si es posible iniciar sesión, recibirás un enlace por correo. Ábrelo en este navegador.",invalid:"Este acceso ha caducado o pertenece a otro navegador. Conecta Academy de nuevo.",privacy:"Privacidad",permission:"Permisos",provider:"Continuar con"},
} as const;
function json(res: ServerResponse, status: number, value: unknown): true {
  res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});
  res.end(JSON.stringify(value)); return true;
}
function oauthError(res: ServerResponse, error: string, status=400): true { return json(res,status,{error}); }
function page(res: ServerResponse, locale: Locale, body: string, status=200): true {
  res.writeHead(status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
  res.end(brandedPageShell(locale,TEXT[locale].title,body)); return true;
}
function browser(req: IncomingMessage): string {
  const value = (req.headers.cookie ?? "").split(";").map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1) ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
function setBrowser(res: ServerResponse, value: string): void {
  res.setHeader("Set-Cookie",`${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/authorize; Max-Age=600${new URL(getBaseUrl()).protocol==="https:" ? "; Secure" : ""}`);
}
async function body(req: IncomingMessage): Promise<URLSearchParams> {
  let size=0; const chunks: Buffer[]=[];
  for await(const chunk of req) {const buffer=Buffer.from(chunk as Uint8Array); size+=buffer.length; if(size>MAX_BODY) throw new Error("invalid_request"); chunks.push(buffer);}
  const raw=Buffer.concat(chunks).toString("utf8");
  if(req.headers["content-type"]?.startsWith("application/json")) {
    const parsed:unknown=JSON.parse(raw); if(!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw new Error("invalid_request");
    const form=new URLSearchParams(); for(const [key,value] of Object.entries(parsed)) if(typeof value==="string") form.set(key,value); return form;
  }
  return new URLSearchParams(raw);
}
export function isValidRedirectUri(raw: string): boolean {
  if(typeof raw!=="string" || raw.length>2048) return false;
  try {const url=new URL(raw); if(url.hash || url.username || url.password) return false;
    return url.protocol==="http:" ? ["localhost","127.0.0.1","[::1]"].includes(url.hostname) : ["https:","claude:","chatgpt:","mcp:","cursor:"].includes(url.protocol);
  } catch {return false;}
}
export async function hydrateOAuthState(): Promise<{clients:number;tokens:number}> {
  // Validate persistence and additive schema before opening the socket. No maps hold authority.
  const result=await getDb().query<{clients:string;tokens:string}>(`SELECT (SELECT count(*) FROM academy_mcp_oauth_clients)::text AS clients,
    (SELECT count(*) FROM academy_mcp_oauth_access_tokens WHERE expires_at>NOW())::text AS tokens`);
  await getDb().query("SELECT scopes,resource,grant_version,consented_at FROM academy_mcp_oauth_access_tokens LIMIT 0");
  await getDb().query("SELECT family_id FROM academy_mcp_oauth_revoked_families LIMIT 0");
  if(agentIdentityEnabled())await getDb().query("SELECT id FROM academy_mcp_agent_registrations LIMIT 0");
  return {clients:Number(result.rows[0]?.clients ?? 0),tokens:Number(result.rows[0]?.tokens ?? 0)};
}
export function startOAuthCleanup(): NodeJS.Timeout {
  return setInterval(()=>{void cleanupExpiredOAuthState().then(()=>cleanupExpiredProviderStates()).then(()=>agentIdentityEnabled()?cleanupAgentIdentities():undefined).catch(()=>console.error("[academy-oauth] cleanup failed"));},300000).unref();
}
export async function checkBearerToken(req: IncomingMessage) {
  const raw=req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const principal=raw ? await authenticateBearer(raw) : null;
  return principal ? {ok:true as const,...principal} : {ok:false as const,error:"invalid_token"};
}
async function authorizePage(req: IncomingMessage,res: ServerResponse,url: URL): Promise<true> {
  const locale=detectLocale(req,getBaseUrl()); const copy=TEXT[locale];
  const client=await getClient(url.searchParams.get("client_id") ?? "");
  const redirect=url.searchParams.get("redirect_uri") ?? "";
  const challenge=url.searchParams.get("code_challenge") ?? "";
  const resource=url.searchParams.get("resource") ?? MCP_RESOURCE;
  let scopes: Scope[];
  try {scopes=parseScopes(url.searchParams.get("scope") ?? "learn:read learn:write");} catch {return oauthError(res,"invalid_scope");}
  if(url.searchParams.get("response_type")!=="code" || url.searchParams.get("code_challenge_method")!=="S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !client || !client.redirect_uris.includes(redirect)) return oauthError(res,"invalid_request");
  if(!resourceAllowed(resource) || url.searchParams.getAll("resource").length>1) return oauthError(res,"invalid_target");
  const nonce=browser(req) || randomToken(); const csrf=randomToken(); const requestId=randomToken();
  const authorization:Authorization={client_id:client.client_id,redirect_uri:redirect,code_challenge:challenge,state:url.searchParams.get("state") ?? "",scopes,resource,grant_version:2,consented_at:null,browser_hash:hashToken(nonce)};
  await saveAuthorization(requestId,authorization,hashToken(csrf)); setBrowser(res,nonce);
  const choices=scopes.map(scope=>`<p><label><input type="checkbox" name="scope" value="${scope}"${scope==="credits:spend" ? "" : " checked"}> ${esc(scope==="learn:read" ? copy.read : scope==="learn:write" ? copy.write : copy.spend)}</label></p>`).join("");
  const providers=enabledProviders().map(provider=>`<p><button name="method" value="${provider}" type="submit">${esc(copy.provider)} ${provider==="google" ? "Google" : "Discord"}</button></p>`).join("");
  return page(res,locale,`<h2>${esc(copy.title)}</h2><p>${esc(client.client_name)}</p><p>${esc(copy.intro)}</p><form method="post" action="/authorize"><input type="hidden" name="request_id" value="${requestId}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="lang" value="${locale}"><fieldset><legend>${esc(copy.permission)}</legend>${choices}</fieldset>${providers}<p><label>${esc(copy.email)} <input type="email" name="email" autocomplete="email"></label></p><p><button name="method" value="email" type="submit">${esc(copy.send)}</button></p></form><p><a href="https://studiomeyer.academy/${locale}/datenschutz">${esc(copy.privacy)}</a></p>`);
}
async function authorizeSubmit(req: IncomingMessage,res: ServerResponse): Promise<true> {
  const form=await body(req); const requestedLocale=form.get("lang"); const locale:Locale=requestedLocale==="en" || requestedLocale==="es" ? requestedLocale : "de"; const copy=TEXT[locale];
  const nonce=browser(req);
  const authorization=nonce ? await consumeAuthorization(form.get("request_id") ?? "",hashToken(nonce),hashToken(form.get("csrf") ?? "")) : null;
  if(!authorization) return oauthError(res,"access_denied",403);
  let scopes:Scope[]; try {scopes=parseScopes(form.getAll("scope").join(" "));} catch{return oauthError(res,"invalid_scope");}
  if(scopes.some(scope=>!authorization.scopes.includes(scope))) return oauthError(res,"invalid_scope");
  const grant={...authorization,scopes,grant_version:2,consented_at:new Date()};
  const method=form.get("method");
  if(isProvider(method)) {
    if(!isProviderEnabled(method)) return oauthError(res,"invalid_request");
    const state=await createProviderState({provider:method,client_id:grant.client_id,redirect_uri:grant.redirect_uri,pkce_challenge:grant.code_challenge,client_state:grant.state,grant,browser_hash:grant.browser_hash});
    res.writeHead(302,{Location:buildProviderAuthorizeUrl({provider:method,baseUrl:getBaseUrl(),state}),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});res.end();return true;
  }
  const email=normalizeEmail(form.get("email") ?? "");
  if(!isValidEmail(email)) return oauthError(res,"invalid_request");
  const budget=checkMagicLinkMailBudget(email,{requesterIp:clientIp(req)});
  if(budget.ok && await isUserAllowed(email)) {
    const token=randomToken(); await saveMagicLink(token,{...grant,email});
    await sendMagicLinkEmail(email,`${getBaseUrl()}/authorize/verify?token=${encodeURIComponent(token)}&lang=${locale}`);
  }
  return page(res,locale,`<p>${esc(copy.sent)}</p>`);
}
async function redirectCode(res:ServerResponse,authorization:Authorization,email:string):Promise<true> {
  if(!await isUserAllowed(email)) return oauthError(res,"access_denied",403);
  const code=await saveAuthCode({...authorization,email:normalizeEmail(email)});
  const destination=new URL(authorization.redirect_uri);destination.searchParams.set("code",code);destination.searchParams.set("iss",getBaseUrl());if(authorization.state)destination.searchParams.set("state",authorization.state);
  res.writeHead(302,{Location:destination.toString(),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});res.end();return true;
}
export async function handleOAuth(req: IncomingMessage,res: ServerResponse):Promise<boolean> {
  const url=new URL(req.url ?? "/",getBaseUrl()); const path=url.pathname;
  if(req.method==="GET" && ["/.well-known/oauth-protected-resource","/.well-known/oauth-protected-resource/mcp"].includes(path)) return json(res,200,{resource:MCP_RESOURCE,authorization_servers:[getBaseUrl()],scopes_supported:SCOPES,bearer_methods_supported:["header"]});
  if(req.method==="GET" && ["/.well-known/oauth-authorization-server","/.well-known/oauth-authorization-server/mcp"].includes(path)) return json(res,200,{issuer:getBaseUrl(),authorization_endpoint:`${getBaseUrl()}/authorize`,token_endpoint:`${getBaseUrl()}/token`,registration_endpoint:`${getBaseUrl()}/register`,revocation_endpoint:`${getBaseUrl()}/revoke`,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token",...(agentIdentityEnabled()?[ASSERTION_GRANT,CLAIM_GRANT]:[])],code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"],scopes_supported:SCOPES,authorization_response_iss_parameter_supported:true,...(agentAuthMetadata()?{agent_auth:agentAuthMetadata()}: {})});
  if(await handleAgentIdentity(req,res))return true;
  if(!["/register","/authorize","/authorize/verify","/token","/revoke","/authorize/google/callback","/authorize/discord/callback"].includes(path)) return false;
  const rate=checkIpRateLimit(clientIp(req));if(!rate.ok){res.setHeader("Retry-After",String(rate.retry_after_seconds ?? 60));return oauthError(res,"temporarily_unavailable",429);}
  try {
    if(path==="/register" && req.method==="POST") {
      let size=0; const chunks:Buffer[]=[];for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>MAX_BODY)return oauthError(res,"invalid_client_metadata");chunks.push(Buffer.from(chunk));}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString());if(!value || typeof value!=="object" || Array.isArray(value))return oauthError(res,"invalid_client_metadata");
      const input=value as Record<string,unknown>;const uris=input.redirect_uris;
      if(!Array.isArray(uris) || uris.length===0 || uris.length>10 || uris.some(uri=>typeof uri!=="string" || !isValidRedirectUri(uri)) || (input.token_endpoint_auth_method!==undefined && input.token_endpoint_auth_method!=="none"))return oauthError(res,"invalid_client_metadata");
      const client={client_id:randomToken(),client_name:typeof input.client_name==="string" ? input.client_name.slice(0,200) : "MCP Client",redirect_uris:uris as string[]};
      await saveClient(client);return json(res,201,{...client,token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]});
    }
    if(path==="/authorize" && req.method==="GET") return authorizePage(req,res,url);
    if(path==="/authorize" && req.method==="POST") return authorizeSubmit(req,res);
    if(path==="/authorize/verify" && req.method==="GET") {
      const locale=detectLocale(req,getBaseUrl());const nonce=browser(req);const authorization=nonce ? await consumeMagicLink(url.searchParams.get("token") ?? "",hashToken(nonce)) : null;
      if(!authorization?.email) return page(res,locale,`<p>${esc(TEXT[locale].invalid)}</p>`,400);
      return redirectCode(res,authorization,authorization.email);
    }
    const callback=/^\/authorize\/(google|discord)\/callback$/.exec(path);
    if(callback && req.method==="GET" && isProvider(callback[1])) {
      const provider=callback[1];const nonce=browser(req);
      if(!nonce || !url.searchParams.get("code") || url.searchParams.has("error"))return oauthError(res,"access_denied",403);
      const state=await consumeProviderState(url.searchParams.get("state") ?? "",hashToken(nonce));
      if(!state || state.provider!==provider)return oauthError(res,"access_denied",403);
      const access=await exchangeProviderCode({provider,baseUrl:getBaseUrl(),code:url.searchParams.get("code")!});
      const profile=await fetchProviderProfile({provider,access_token:access});
      return redirectCode(res,{...state,code_challenge:state.pkce_challenge,state:state.client_state ?? ""},profile.email);
    }
    if(path==="/token" && req.method==="POST") {
      const form=await body(req);if(form.getAll("resource").length>1)return oauthError(res,"invalid_target");
      if(agentIdentityEnabled()&&[ASSERTION_GRANT,CLAIM_GRANT].includes(form.get("grant_type")??"")) {
        try {return json(res,200,form.get("grant_type")===ASSERTION_GRANT?await exchangeAgentAssertion(form):await pollAgentClaim(form));}
        catch(error){if(error instanceof AgentIdentityError)return oauthError(res,error.code,error.status);throw error;}
      }
      const result=form.get("grant_type")==="authorization_code" ? await redeemCode(form) : form.get("grant_type")==="refresh_token" ? await rotateRefresh(form) : null;
      if(!result)return oauthError(res,"unsupported_grant_type");return result.ok ? json(res,200,result.pair) : oauthError(res,result.error);
    }
    if(path==="/revoke" && req.method==="POST") {const form=await body(req);if(agentIdentityEnabled()&&await revokeAgentAccess(form.get("token")??""))return json(res,200,{});await revokeToken(form.get("token") ?? "",form.get("client_id") ?? "");return json(res,200,{});}
    return oauthError(res,"invalid_request",405);
  } catch(error) {
    if(error instanceof SyntaxError || error instanceof Error && error.message==="invalid_request")return oauthError(res,"invalid_request");
    console.error("[academy-oauth] request failed",error instanceof Error ? error.name : "unknown");
    return oauthError(res,"temporarily_unavailable",503);
  }
}
