/** Live Academy operation registry and shared execute contract. No content bundle. */
import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SCOPES, hasScopes, MCP_RESOURCE, type Grant } from "./auth/grants.js";

export interface Envelope extends Record<string,unknown> {
  success: boolean; result: unknown;
  errors: Array<{code:number;slug:string;message:string;hint:string;documentation_url:string}>;
  messages: unknown[]; request_id: string;
}
export interface Operation {
  id: string; description: string; rest: Array<{method:string;path:string}>;
  mcp: {names:string[];deprecatedAliases:string[];annotations:NonNullable<Tool["annotations"]>} | null;
  inputSchema: Tool["inputSchema"]; outputSchema: JsonSchemaType;
  requiredScopes: string[]; creditEffect: unknown; public:boolean;
}
export interface Registry {operations:Operation[]; [key:string]:unknown}
export interface CallIdentity {grant:Grant;accessToken:string; revalidate:()=>Promise<Grant | null>}
export type AcademyLocale="de"|"en"|"es";
const ajv=new Ajv2020({strict:false,allErrors:true});
addFormats(ajv);
const validator=new AjvJsonSchemaValidator(ajv);
export function academyBaseUrl(): string {
  const url=new URL(process.env.ACADEMY_BASE_URL || "https://studiomeyer.academy");
  if(url.protocol!=="https:" && !(url.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Academy base URL must use HTTPS or loopback HTTP");
  if(url.username || url.password || url.search || url.hash || url.pathname!=="/") throw new Error("Academy base URL must be an origin");
  return url.origin;
}
const LOCAL_ERRORS:Record<string,Record<"de"|"es",[string,string]>>={
  auth_required:{de:["Diese Aktion benötigt eine Anmeldung.","Verbinde die Academy mit OAuth oder nutze den freien Eingang."],es:["Esta operación requiere iniciar sesión.","Conecta Academy mediante OAuth o usa el acceso público."]},
  invalid_token:{de:["Die Anmeldung ist ungültig oder abgelaufen.","Verbinde die Academy erneut mit OAuth."],es:["La autorización no es válida o ha caducado.","Vuelve a conectar Academy mediante OAuth."]},
  insufficient_scope:{de:["Für diese Aktion fehlt eine Berechtigung.","Verbinde die Academy erneut und lass die Person die benötigten Berechtigungen auswählen."],es:["Falta un permiso para esta operación.","Vuelve a conectar Academy para que la persona elija los permisos necesarios."]},
  credits_spend_not_granted:{de:["Die KI darf keine Credits ausgeben.","Die Person muss credits:spend bei einer neuen OAuth-Verbindung ausdrücklich auswählen."],es:["La IA no tiene permiso para gastar créditos.","La persona debe seleccionar credits:spend al volver a conectar mediante OAuth."]},
  confirmation_required:{de:["Die ausdrückliche Bestätigung fehlt.","Zeige der Person Inhalt und Preis und hole vor dem Aufruf ihre Zustimmung ein."],es:["Falta la confirmación explícita.","Muestra el contenido y el precio y pide la confirmación antes de continuar."]},
  idempotency_key_required:{de:["Der Schlüssel für diesen Vorgang fehlt.","Sende einen eindeutigen idempotencyKey und verwende ihn bei Wiederholungen desselben Vorgangs erneut."],es:["Falta la clave de esta operación.","Envía una idempotencyKey única y reutilízala al reintentar la misma operación."]},
  locale_not_supported:{de:["Diese Sprache wird nicht unterstützt.","Verwende de, en oder es."],es:["Este idioma no es compatible.","Usa de, en o es."]},
  validation_failed:{de:["Die Eingabe entspricht nicht dem Schema.","Lies tools/list und verwende die dort angegebenen Felder und Typen."],es:["La entrada no coincide con el esquema.","Consulta tools/list y usa los campos y tipos indicados."]},
  temporarily_unavailable:{de:["Der Academy-Dienst ist vorübergehend nicht verfügbar.","Versuche es später erneut. Bei einem unklaren Credit-Ergebnis lies zuerst die Buchungen."],es:["El servicio de Academy no está disponible temporalmente.","Inténtalo más tarde. Si una operación de créditos es incierta, consulta primero el registro."]},
  rate_limited:{de:["Zu viele Anfragen.","Warte die in Retry-After angegebene Zeit ab."],es:["Demasiadas solicitudes.","Espera el tiempo indicado en Retry-After."]},
  not_found:{de:["Diese Funktion wurde nicht gefunden.","Lies tools/list für die aktuell verfügbaren Funktionen."],es:["No se ha encontrado esta función.","Consulta tools/list para ver las funciones disponibles."]},
  account_suspended:{de:["Der Zugang zu diesem Konto ist gesperrt.","Wende dich an den Academy-Support."],es:["El acceso a esta cuenta está suspendido.","Contacta con el soporte de Academy."]},
};
export function failure(slug:string,code:number,message:string,hint:string,locale:AcademyLocale="de"):Envelope {
  const translated=locale!=="en" ? LOCAL_ERRORS[slug]?.[locale] : undefined;
  if(translated)[message,hint]=translated;
  return {success:false,result:null,errors:[{slug,code,message,hint,documentation_url:`https://studiomeyer.academy/v1/errors#${slug}`}],messages:[],request_id:`req_${randomUUID()}`};
}
export function isEnvelope(value:unknown):value is Envelope {
  if(!value || typeof value!=="object")return false;
  const row=value as Record<string,unknown>;
  return typeof row.success==="boolean" && "result" in row && Array.isArray(row.errors) && row.errors.every(error=>{
    if(!error || typeof error!=="object")return false;const e=error as Record<string,unknown>;
    return typeof e.code==="number" && ["slug","message","hint","documentation_url"].every(key=>typeof e[key]==="string" && (e[key] as string).length>0);
  }) && Array.isArray(row.messages) && typeof row.request_id==="string" && row.request_id.length>0 && (row.success ? row.errors.length===0 : row.errors.length>0);
}
export class AcademyUnavailable extends Error {
  constructor(readonly envelope:Envelope){super("Academy service unavailable");}
}
async function request(path:string,init:RequestInit={}):Promise<Response> {
  return fetch(new URL(path,academyBaseUrl()),{...init,redirect:"error",signal:AbortSignal.timeout(15000)});
}
export async function loadRegistry():Promise<Registry> {
  try {
    const response=await request("/v1",{headers:{Accept:"application/json"}});
    const envelope:unknown=await response.json();
    if(!response.ok || !isEnvelope(envelope) || !envelope.success || !envelope.result || typeof envelope.result!=="object")throw new Error("Invalid registry envelope");
    const registry=envelope.result as Registry;
    if(!Array.isArray(registry.operations) || registry.operations.length===0)throw new Error("Missing operations");
    const names=new Set<string>();const ids=new Set<string>();
    for(const operation of registry.operations) {
      if(!operation || typeof operation.id!=="string" || ids.has(operation.id) || typeof operation.description!=="string" || !Array.isArray(operation.requiredScopes) || operation.requiredScopes.some(scope=>!SCOPES.includes(scope as typeof SCOPES[number])) || typeof operation.public!=="boolean" || operation.inputSchema?.type!=="object" || !operation.outputSchema || typeof operation.outputSchema!=="object")throw new Error("Invalid registry operation");
      ids.add(operation.id);
      validator.getValidator(operation.inputSchema);validator.getValidator(operation.outputSchema);
      if(operation.mcp) {
        if(!Array.isArray(operation.mcp.names) || !Array.isArray(operation.mcp.deprecatedAliases) || !operation.mcp.annotations || typeof operation.mcp.annotations.readOnlyHint!=="boolean")throw new Error("Invalid tool metadata");
        for(const name of [...operation.mcp.names,...operation.mcp.deprecatedAliases]) {
          if(typeof name!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(name) || names.has(name))throw new Error("Duplicate or invalid tool name");names.add(name);
        }
      }
    }
    return registry;
  } catch(error) {
    if(error instanceof AcademyUnavailable)throw error;
    throw new AcademyUnavailable(failure("temporarily_unavailable",9002,"Academy registry is unavailable.","Retry later; the MCP requires the live Academy registry."));
  }
}
function canAccess(operation:Operation,grant:Grant|null):boolean {
  return operation.public || !!grant && grant.resource===MCP_RESOURCE && hasScopes(grant,operation.requiredScopes);
}
const errorSchema={type:"object",required:["code","slug","message","hint","documentation_url"],properties:{code:{type:"number"},slug:{type:"string",minLength:1},message:{type:"string",minLength:1},hint:{type:"string",minLength:1},documentation_url:{type:"string",minLength:1}},additionalProperties:true};
/** Rebase local JSON pointers because the service schema moves inside the envelope. */
function nestedSchema(schema:unknown,pointer:string):unknown {
  if(Array.isArray(schema))return schema.map(item=>nestedSchema(item,pointer));
  if(!schema || typeof schema!=="object")return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key])=>key!=="$schema").map(([key,value])=>[key,(key==="$ref" || key==="$dynamicRef") && typeof value==="string" && value.startsWith("#/") ? `${pointer}${value.slice(1)}` : nestedSchema(value,pointer)]));
}
export function envelopeOutputSchema(resultSchema:JsonSchemaType):NonNullable<Tool["outputSchema"]> {
  return {type:"object",required:["success","result","errors","messages","request_id"],properties:{success:{type:"boolean"},result:{},errors:{type:"array",items:errorSchema},messages:{type:"array"},request_id:{type:"string",minLength:1}},oneOf:[
    {properties:{success:{const:true},result:nestedSchema(resultSchema,"#/oneOf/0/properties/result"),errors:{maxItems:0}}},
    {properties:{success:{const:false},result:{type:"null"},errors:{minItems:1}}},
  ]};
}
const TRANSPORT_PROPERTIES={locale:{type:"string" as const,enum:["de","en","es"],default:"de",description:"MCP transport locale; not a service input field."},idempotencyKey:{type:"string" as const,minLength:1,maxLength:200,description:"Transport retry key, forwarded as Idempotency-Key."}};
/** Strict object-union branches must explicitly admit the same transport fields. */
function withTransportProperties(schema:JsonSchemaType):JsonSchemaType {
  const extended:JsonSchemaType={...schema,properties:{...schema.properties,...TRANSPORT_PROPERTIES}};
  for(const keyword of ["oneOf","anyOf","allOf"] as const) {
    const branches=schema[keyword];
    if(Array.isArray(branches))extended[keyword]=branches.map(branch=>typeof branch==="object" ? withTransportProperties(branch) : branch);
  }
  return extended;
}
function toolInputSchema(operation:Operation,name:string):Tool["inputSchema"] {
  const alias=operation.mcp!.deprecatedAliases.includes(name);
  return {...withTransportProperties(operation.inputSchema),type:"object",properties:{...operation.inputSchema.properties,...TRANSPORT_PROPERTIES},required:operation.inputSchema.required,...(alias ? {required:[],additionalProperties:true,description:"Deprecated alias: legacy fields are normalized and strictly validated by Academy."} : {})};
}
export function toolsFor(registry:Registry,grant:Grant|null):Tool[] {
  return registry.operations.filter(operation=>operation.mcp && canAccess(operation,grant)).flatMap(operation=>{
    const metadata=operation.mcp!;
    return [...metadata.names,...metadata.deprecatedAliases].map(name=>({name,description:metadata.deprecatedAliases.includes(name) ? `${operation.description} (Deprecated alias for ${metadata.names[0]}; retained for one version.)` : operation.description,inputSchema:toolInputSchema(operation,name),outputSchema:envelopeOutputSchema(operation.outputSchema),annotations:metadata.annotations,...(metadata.deprecatedAliases.includes(name) ? {_meta:{deprecated:true,canonicalName:metadata.names[0]}} : {})}));
  });
}
/** Protocol errors are separate from operation execution/business errors. */
export function validateToolCall(registry:Registry,name:string,input:Record<string,unknown>):Envelope|null {
  const locale:AcademyLocale=input.locale==="en"||input.locale==="es"?input.locale:"de";
  const operation=registry.operations.find(op=>op.mcp && [...op.mcp.names,...op.mcp.deprecatedAliases].includes(name));
  if(!operation)return failure("not_found",1101,"Unknown tool.","Read tools/list for available tools.",locale);
  if(!validator.getValidator(toolInputSchema(operation,name))(input).valid)return failure("validation_failed",1100,"Invalid tool arguments.","Read tools/list and use the declared fields and types.",locale);
  return null;
}
export async function executeOperation(registry:Registry,name:string,input:Record<string,unknown>,identity:CallIdentity|null):Promise<Envelope> {
  const errorLocale:AcademyLocale=input.locale==="en" || input.locale==="es" ? input.locale : "de";
  const fail=(slug:string,code:number,message:string,hint:string)=>failure(slug,code,message,hint,errorLocale);
  const operation=registry.operations.find(op=>op.mcp && [...op.mcp.names,...op.mcp.deprecatedAliases].includes(name));
  if(!operation)return fail("not_found",1101,"Unknown tool.","Read tools/list for the current operation registry.");
  let grant=identity?.grant ?? null;
  if(!operation.public && identity) {
    try {grant=await identity.revalidate();} catch {return fail("temporarily_unavailable",9002,"Authorization cannot be verified.","Retry later.");}
  }
  if(!operation.public && grant && grant.resource!==MCP_RESOURCE)return fail("invalid_token",1001,"This token is for another resource.","Use an OAuth token issued for the MCP resource.");
  if(!canAccess(operation,grant)) {
    const spending=operation.requiredScopes.includes("credits:spend") && !grant?.scopes.includes("credits:spend");
    return fail(identity && grant ? spending ? "credits_spend_not_granted" : "insufficient_scope" : "auth_required",identity && grant ? spending ? 1003 : 1002 : 1000,"This operation needs additional authorization.","Reconnect using OAuth and let the person select the required scopes.");
  }
  const {locale="de",idempotencyKey,...serviceInput}=input;
  if(!["de","en","es"].includes(locale as string))return fail("locale_not_supported",1107,"Unsupported locale.","Use de, en or es.");
  if(idempotencyKey!==undefined && (typeof idempotencyKey!=="string" || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)))return fail("validation_failed",1100,"Invalid idempotency key.","Use a nonempty ASCII idempotencyKey of at most 200 characters.");
  const alias=operation.mcp!.deprecatedAliases.includes(name);
  // Only declared legacy aliases defer normalization to Academy. Canonical inputs stay strict.
  if(!alias && !validator.getValidator(operation.inputSchema)(serviceInput).valid)return fail("validation_failed",1100,"The tool input does not match its schema.","Read tools/list and supply the declared fields and types.");
  const payment=serviceInput.payment;
  const paid=operation.creditEffect==="spend" || operation.creditEffect==="conditional" && payment && typeof payment==="object" && (payment as Record<string,unknown>).kind==="credits";
  if(paid && !grant?.scopes.includes("credits:spend"))return fail("credits_spend_not_granted",1003,"This grant cannot spend credits.","Reconnect with explicit credits:spend consent.");
  if(paid && idempotencyKey===undefined)return fail("idempotency_key_required",1104,"Credit spending needs an idempotency key.","Reuse one unique idempotencyKey for retries of this confirmed action.");
  // Quote consent and stored spending approvals remain authoritative Academy business rules.
  const headers:Record<string,string>={"Content-Type":"application/json",Accept:"application/json"};
  if(typeof idempotencyKey==="string")headers["Idempotency-Key"]=idempotencyKey;
  if(!operation.public) {
    const service=process.env.ACADEMY_MCP_SERVICE_TOKEN;
    if(!identity || !service)return fail("temporarily_unavailable",9002,"Personal Academy operations are unavailable.","The service operator must configure the Academy service authorization.");
    headers.Authorization=`Bearer ${identity.accessToken}`;
    headers["X-Academy-Service-Authorization"]=`Bearer ${service}`;
  }
  try {
    const response=await request("/api/academy/execute",{method:"POST",headers,body:JSON.stringify({operation:operation.id,input:serviceInput,locale})});
    const envelope:unknown=await response.json();
    if(!isEnvelope(envelope))throw new Error("Invalid service envelope");
    if(!response.ok && envelope.success)throw new Error("Inconsistent service status");
    if(envelope.success && !validator.getValidator(operation.outputSchema)(envelope.result).valid)throw new Error("Service result does not match declared result schema");
    if(!validator.getValidator(envelopeOutputSchema(operation.outputSchema))(envelope).valid)throw new Error("Service envelope does not match MCP output schema");
    return envelope;
  } catch {return fail("temporarily_unavailable",9002,"Academy service is unavailable.","Retry later. For an uncertain credit outcome, inspect the credit ledger before retrying.");}
}

const DOCS={quickstart:"/quickstart.md",errors:"/v1/errors","package-format":"/entwickler/paketformat.md"} as const;
export const DOCUMENT_URIS=Object.keys(DOCS).map(id=>`academy://docs/${id}`);
export async function readDocumentation(uri:string,registry:Registry):Promise<string> {
  const key=uri.replace("academy://docs/","") as keyof typeof DOCS;
  if(!DOCUMENT_URIS.includes(uri))throw new Error("Unknown documentation resource");
  // Root publishes links; confirmed machine paths cover older index envelopes.
  const docs=registry.links;
  const fromIndex=docs && typeof docs==="object" ? (docs as Record<string,unknown>)[key==="package-format" ? "package_format" : key] : undefined;
  const target=typeof fromIndex==="string" ? new URL(fromIndex,academyBaseUrl()) : new URL(DOCS[key],academyBaseUrl());
  if(target.origin!==academyBaseUrl())throw new Error("Documentation must belong to Academy");
  const response=await request(`${target.pathname}${target.search}`,{headers:{Accept:"text/markdown"}});
  if(!response.ok || !(response.headers.get("content-type") ?? "").match(/text\/(markdown|plain)/))throw new Error("Live documentation unavailable");
  return response.text();
}
