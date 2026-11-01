import { detectLocale,type Locale } from "./i18n.js";
import { CLAIM_COPY } from "./agent-identity-copy.js";
/** WorkOS auth.md anonymous profile. Human claim is email-verified, browser-bound and never grants spending. */
import type { IncomingMessage,ServerResponse } from "node:http";
import { getBaseUrl } from "../core/base-url.js";
import { clientIp } from "../core/client-ip.js";
import { checkIpRateLimit,checkMagicLinkMailBudget } from "../safety/rate-limit.js";
import { normalizeEmail,isValidEmail,isUserAllowed } from "./users.js";
import { randomToken } from "./oauth-persistence.js";
import { sendMagicLinkEmail } from "./email-magic.js";
import { brandedPageShell,escHtml as esc } from "./page-shell.js";
import { agentIdentityEnabled } from "./agent-assertions.js";
import { AgentIdentityError,registerAnonymousAgent,beginAgentClaim,bindClaimBrowser,prepareClaimMagic,verifyClaimMagic,approveAgentClaim } from "./agent-identity-store.js";
import type { Scope } from "./grants.js";
const COOKIE="academy_agent_claim_browser",BASE="/agent/identity",CLAIM=`${BASE}/claim`;
function json(res:ServerResponse,status:number,value:unknown):true {res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"});res.end(JSON.stringify(value));return true;}
function page(res:ServerResponse,html:string,status=200,locale:Locale="en"):true {
  res.writeHead(status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(brandedPageShell(locale,CLAIM_COPY[locale].title,html));return true;
}
function browser(req:IncomingMessage):string {
  const raw=(req.headers.cookie??"").split(";").map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1)??"";
  return /^[A-Za-z0-9_-]{43}$/.test(raw)?raw:"";
}
async function body(req:IncomingMessage):Promise<URLSearchParams> {
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){const bytes=Buffer.from(chunk as Uint8Array);size+=bytes.length;if(size>65536)throw new AgentIdentityError("invalid_request",413);chunks.push(bytes);}
  const raw=Buffer.concat(chunks).toString("utf8"),type=req.headers["content-type"]??"";
  if(type.startsWith("application/x-www-form-urlencoded"))return new URLSearchParams(raw);
  if(!type.startsWith("application/json"))throw new AgentIdentityError("invalid_request",415);
  const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object"||Array.isArray(value))throw new AgentIdentityError("invalid_request");
  const form=new URLSearchParams();for(const [key,v] of Object.entries(value)){if(typeof v!=="string")throw new AgentIdentityError("invalid_request");form.append(key,v);}return form;
}
function only(form:URLSearchParams,keys:string[]):void {for(const key of form.keys())if(!keys.includes(key)||form.getAll(key).length!==1)throw new AgentIdentityError("invalid_request");}
function sameOrigin(req:IncomingMessage):boolean {return req.headers.origin===getBaseUrl();}

export async function handleAgentIdentity(req:IncomingMessage,res:ServerResponse):Promise<boolean> {
  const url=new URL(req.url??"/",getBaseUrl()),locale=detectLocale(req,getBaseUrl()),copy=CLAIM_COPY[locale];
  const render=(html:string,status=200)=>page(res,html,status,locale);
  const expired=`<h2>${copy.invalidTitle}</h2><p>${copy.invalid}</p>`;
  if(![BASE,CLAIM,`${CLAIM}/verify`,`${CLAIM}/confirm`].includes(url.pathname))return false;
  if(!agentIdentityEnabled())return json(res,503,{error:"anonymous_not_enabled"});
  const rate=checkIpRateLimit(clientIp(req));if(!rate.ok){res.setHeader("Retry-After",String(rate.retry_after_seconds??60));return json(res,429,{error:"rate_limited"});}
  if(req.method==="OPTIONS"){res.setHeader("Allow","GET, POST, OPTIONS");return json(res,200,{});}
  try {
    if(url.pathname===BASE&&req.method==="POST") {
      const form=await body(req);only(form,["type"]);
      if(form.get("type")!=="anonymous")return json(res,400,{error:form.get("type")==="service_auth"?"service_auth_not_enabled":form.get("type")==="identity_assertion"?"issuer_not_enabled":"invalid_request"});
      return json(res,200,await registerAnonymousAgent());
    }
    if(url.pathname===CLAIM&&req.method==="POST") {
      const form=await body(req);only(form,["claim_token","email"]);
      const email=normalizeEmail(form.get("email")??""),token=form.get("claim_token")??"";
      if(!isValidEmail(email)||!/^clm_[A-Za-z0-9_-]{43}$/.test(token))throw new AgentIdentityError("invalid_request");
      return json(res,200,await beginAgentClaim(token,email));
    }
    if(url.pathname===`${CLAIM}/verify`&&req.method==="GET") {
      const token=url.searchParams.get("claim_attempt_token")??"",nonce=browser(req)||randomToken(),csrf=randomToken();
      if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!await bindClaimBrowser(token,nonce,csrf))return render(expired,400);
      res.setHeader("Set-Cookie",`${COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/agent/identity/claim; Max-Age=600${new URL(getBaseUrl()).protocol==="https:"?"; Secure":""}`);
      return render(`<h2>${copy.signIn}</h2><p>${copy.intro}</p><form method="post" action="${CLAIM}/verify?lang=${locale}"><input type="hidden" name="claim_attempt_token" value="${esc(token)}"><input type="hidden" name="csrf" value="${csrf}"><p><label>${copy.email} <input name="email" type="email" autocomplete="email" required></label></p><p><button type="submit">${copy.send}</button></p></form>`);
    }
    if(url.pathname===`${CLAIM}/verify`&&req.method==="POST") {
      if(!sameOrigin(req))throw new AgentIdentityError("access_denied",403);
      const form=await body(req);only(form,["claim_attempt_token","csrf","email"]);
      const email=normalizeEmail(form.get("email")??""),nonce=browser(req);
      if(!isValidEmail(email)||!nonce)throw new AgentIdentityError("invalid_request");
      const budget=checkMagicLinkMailBudget(email,{requesterIp:clientIp(req)});
      if(budget.ok&&await isUserAllowed(email)) {
        const token=form.get("claim_attempt_token")??"",magic=await prepareClaimMagic(token,nonce,form.get("csrf")??"",email);
        if(magic)await sendMagicLinkEmail(email,`${getBaseUrl()}${CLAIM}/confirm?token=${magic}&claim_attempt_token=${encodeURIComponent(token)}&lang=${locale}`);
      }
      return render(`<h2>${copy.sentTitle}</h2><p>${copy.sent}</p>`);
    }
    if(url.pathname===`${CLAIM}/confirm`&&req.method==="GET") {
      const nonce=browser(req),token=url.searchParams.get("claim_attempt_token")??"";
      const claim=nonce?await verifyClaimMagic(url.searchParams.get("token")??"",nonce):null;
      const csrf=randomToken(),bound=claim?await bindClaimBrowser(token,nonce,csrf):null;
      if(!claim||!bound||claim.token!==bound.token)return render(expired,400);
      return render(`<h2>${copy.confirm}</h2><p>${copy.signedIn} <strong>${esc(claim.email)}</strong>.</p><p>${copy.permissionIntro}</p><form method="post" action="${CLAIM}/confirm?lang=${locale}"><input type="hidden" name="claim_attempt_token" value="${esc(token)}"><input type="hidden" name="csrf" value="${csrf}"><p><label>${copy.code} <input name="user_code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required></label></p><p><label><input type="checkbox" name="scope" value="learn:read"> ${copy.read}</label></p><p><label><input type="checkbox" name="scope" value="learn:write"> ${copy.write}</label></p><p><button type="submit" name="confirm" value="yes">${copy.submit}</button></p></form>`);
    }
    if(url.pathname===`${CLAIM}/confirm`&&req.method==="POST") {
      if(!sameOrigin(req))throw new AgentIdentityError("access_denied",403);
      const form=await body(req);for(const key of form.keys())if(!["claim_attempt_token","csrf","user_code","scope","confirm"].includes(key)||(key!=="scope"&&form.getAll(key).length!==1))throw new AgentIdentityError("invalid_request");
      const scopes=form.getAll("scope");if(form.get("confirm")!=="yes"||scopes.some(s=>s!=="learn:read"&&s!=="learn:write"))throw new AgentIdentityError("invalid_scope");
      const approved=await approveAgentClaim(form.get("claim_attempt_token")??"",browser(req),form.get("csrf")??"",form.get("user_code")??"",scopes as Scope[]);
      return render(approved?`<h2>${copy.claimed}</h2><p>${copy.done}</p>`:expired,approved?200:403);
    }
    res.setHeader("Allow",url.pathname===BASE||url.pathname===CLAIM?"POST, OPTIONS":"GET, POST, OPTIONS");return json(res,405,{error:"invalid_request"});
  }catch(error){return json(res,error instanceof AgentIdentityError?error.status:error instanceof SyntaxError?400:503,{error:error instanceof AgentIdentityError?error.code:error instanceof SyntaxError?"invalid_request":"temporarily_unavailable"});}
}
