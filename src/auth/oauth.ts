/**
 * OAuth 2.1 + PKCE + Magic-Link fuer mcp-academy.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource → RFC 9728
 *   GET  /.well-known/oauth-authorization-server → RFC 8414
 *   POST /register → Dynamic Client Registration (RFC 7591)
 *   GET  /authorize → branded email-input page
 *   POST /authorize → validate email, send magic-link
 *   GET  /authorize/verify → magic-link callback, issues auth_code
 *   POST /token → exchange code → access+refresh, OR refresh rotation
 *   POST /revoke → RFC 7009
 *
 * Repliziert aus ki-station src/auth/oauth.ts (7. Replikation der
 * sm-service-mcp-Linie). Die Haertungen der Vorlage bleiben woertlich:
 *   - Alle in-memory Maps sind hash-keyed (SHA-256). Klartext lebt nur in
 *     Transit (Bearer header, /token response body, Magic-Link URL). Die DB
 *     speichert nie Klartext.
 *   - DCR validiert redirect_uris: non-empty, https-only (oder localhost-http,
 *     oder custom scheme claude://chatgpt://mcp://cursor://), exact-match in
 *     /authorize (kein Fallback bei leerer Liste).
 *   - Global client cap (MAX_CLIENTS) gegen OOM via Flood-DCR + TOCTOU-Counter.
 *   - rateLimits-Map-Cap (MAX_RATE_BUCKETS) gegen OOM via IP-Spray.
 *   - /authorize/verify rate-limited (Token-Brute-Force-Defense).
 *   - Magic-Link-Verify sendet Cache-Control: no-store + Referrer-Policy:
 *     no-referrer (kein URL-Leak via History/Proxy/Referer).
 *   - Refresh-Rotation mit Token-Familien + Tombstones: Replay eines
 *     verbrauchten Refresh-Tokens revoked die GANZE Familie.
 *   - Auth-Code wird VOR jeder Validierung konsumiert (single-use, kein
 *     PKCE-Guessing gegen liegengebliebene Codes).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  saveClient, saveAuthCode, deleteAuthCodeByHash,
  saveAccessToken, deleteAccessTokenByHash,
  saveRefreshToken, deleteRefreshTokenByHash,
  saveMagicLink, deleteMagicLinkByHash,
  loadOAuthStateFromDb, cleanupExpiredOAuthState,
} from "./oauth-persistence.js";
import { hashToken } from "./token-hash.js";
import { sendMagicLinkEmail } from "./email-magic.js";
import { isValidEmail, normalizeEmail, upsertUser, markUserEmailVerified, isUserAllowed, getUserByEmail } from "./users.js";
import {
  type Provider,
  isProvider,
  enabledProviders,
  cleanupExpiredProviderStates,
} from "./social-providers.js";
import {
  handleProviderStart as socialStart,
  handleProviderCallback as socialCallback,
} from "./social-handlers.js";
import { detectLocale, t } from "./i18n.js";
import { brandedPageShell } from "./page-shell.js";
import { getBaseUrl } from "../core/base-url.js";
import { clientIp as resolveClientIp } from "../core/client-ip.js";
import { checkMagicLinkMailBudget } from "../safety/rate-limit.js";
import { numEnv } from "../core/env.js";

/**
 * Die Basis-URL wird PRO AUFRUF gelesen (getBaseUrl), nicht als
 * Modul-Konstante: eine Konstante fror den Wert beim Import ein und
 * divergierte gegen http-server (Fable-R1 #6). Tests setzen die Env pro Fall.
 */
function baseUrl(): string {
  return getBaseUrl();
}

// ─── Per-IP rate limiter for auth endpoints ──────────────────────────

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX_AUTH = 10;
const RATE_LIMIT_MAX_TOKEN = 20;
const RATE_LIMIT_MAX_REGISTER = 5;
const RATE_LIMIT_MAX_VERIFY = 30; // /authorize/verify — token brute-force defense
/** Cap the Map size so an IP-spray can't OOM the process. */
const MAX_RATE_BUCKETS = 50_000;

function rateLimit(req: IncomingMessage, res: ServerResponse, key: string, max: number): boolean {
  const ip = clientIp(req);
  const bucket = `${key}:${ip}`;
  const now = Date.now();
  const entry = rateLimits.get(bucket);
  if (!entry || now > entry.resetAt) {
    if (rateLimits.size >= MAX_RATE_BUCKETS) {
      // LRU-ish: evict the first 1024 entries (Map iteration is insertion-order).
      let evicted = 0;
      for (const k of rateLimits.keys()) {
        rateLimits.delete(k);
        if (++evicted >= 1024) break;
      }
    }
    rateLimits.set(bucket, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  entry.count++;
  if (entry.count > max) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)),
    });
    res.end(JSON.stringify({ error: "too_many_requests" }));
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries()) if (now > v.resetAt) rateLimits.delete(k);
}, 5 * 60_000).unref();

// ─── In-memory OAuth state (HASH-keyed Maps) ─────────────────────────

interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}
interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  email: string;
  expires_at: number;
}
interface AccessToken {
  client_id: string;
  email: string;
  /** OAuth refresh-token family id: propagated so family-compromise
   *  invalidates ALL paired access tokens. */
  family_id: string;
  created_at: number;
  expires_at: number;
}
interface RefreshTokenEntry {
  client_id: string;
  email: string;
  /** Hash of the paired access-token (so rotation can invalidate it). */
  access_token_hash: string;
  /** Refresh-token family id. New family on auth_code grant; inherited on
   *  rotation. Re-use of a tombstoned token revokes the whole family. */
  family_id: string;
  created_at: number;
  expires_at: number;
}
interface MagicLink {
  email: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  expires_at: number;
}

const clients = new Map<string, Client>(); // client_id is not a secret — plaintext key
const authCodes = new Map<string, AuthCode>();           // KEY = hash(code)
const tokens = new Map<string, AccessToken>();           // KEY = hash(access_token)
const refreshTokens = new Map<string, RefreshTokenEntry>(); // KEY = hash(refresh_token)
const magicLinks = new Map<string, MagicLink>();         // KEY = hash(magic_token)

/**
 * Tombstone for consumed refresh-tokens. KEY = hash(refresh_token);
 * VALUE = family_id. Replay eines Tombstone-Tokens → Familie revoken.
 */
const revokedRefreshTombstone = new Map<string, { family_id: string; revoked_at: number }>();

// Mutex against MCP-SDK #1760 race — keyed by hash(refresh_token)
const refreshInFlight = new Map<string, Promise<RefreshResult>>();

type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; clientId: string; email: string; expiresInSec: number }
  | { ok: false; status: number; body: { error: string; error_description?: string } };

const TOKEN_TTL_MS = 60 * 60 * 1000;             // 1h access
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d refresh
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;          // 5min code
const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;        // 10min magic-link

/** DCR safety: hard-cap to prevent OOM via flood-registration. */
const MAX_CLIENTS = numEnv("ACADEMY_MCP_MAX_OAUTH_CLIENTS", 10_000, { min: 10 });
const REDIRECT_URI_MAX_LEN = 2048;

/**
 * Per-(client_id, email) active-token cap. Ein einzelner OAuth-Client soll
 * fuer denselben User keine unbegrenzten Sessions minten koennen.
 */
const MAX_TOKENS_PER_CLIENT_USER = numEnv("ACADEMY_MCP_MAX_TOKENS_PER_CLIENT_USER", 10);

/**
 * Synchronous in-flight counter for /register (TOCTOU defense): `clients.size`
 * wird erst nach `await parseJson()` aktualisiert; parallele Registers koennten
 * am Size-Check vorbeirutschen. Pre-increment BEFORE the await.
 */
let pendingClientRegistrations = 0;

// ─── DCR redirect_uri validation ─────────────────────────────────────

const ALLOWED_REDIRECT_SCHEMES = new Set(["https:", "claude:", "chatgpt:", "mcp:", "cursor:"]);

export function isValidRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > REDIRECT_URI_MAX_LEN) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "http:") {
    // Allow http only for localhost loopback (dev tooling / native MCP clients).
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  }
  return ALLOWED_REDIRECT_SCHEMES.has(u.protocol);
}

// ─── Token-family helpers ────────────────────────────────────────────

/**
 * Revoke every access + refresh token that shares a family_id.
 * Triggered when a tombstoned refresh-token is replayed.
 */
function revokeEntireFamily(familyId: string, reason: string): { revokedAccess: number; revokedRefresh: number } {
  let revokedAccess = 0;
  let revokedRefresh = 0;
  for (const [h, at] of tokens.entries()) {
    if (at.family_id === familyId) {
      tokens.delete(h);
      deleteAccessTokenByHash(h);
      revokedAccess++;
    }
  }
  for (const [h, rt] of refreshTokens.entries()) {
    if (rt.family_id === familyId) {
      refreshTokens.delete(h);
      deleteRefreshTokenByHash(h);
      revokedRefresh++;
      // Also tombstone the still-live refresh tokens of this family — so a
      // second concurrent replay attempt also gets the family-revoked path.
      revokedRefreshTombstone.set(h, { family_id: familyId, revoked_at: Date.now() });
    }
  }
  console.error(
    `[academy-oauth] FAMILY-REVOKE: family=${familyId} reason="${reason}" ` +
    `revoked_access=${revokedAccess} revoked_refresh=${revokedRefresh}`,
  );
  return { revokedAccess, revokedRefresh };
}

/**
 * Evict the oldest active access+refresh pair for a (client_id, email) tuple
 * if it has reached MAX_TOKENS_PER_CLIENT_USER. O(n_tokens) — fine fuer V1.
 */
function enforceTokenPerClientUserCap(clientId: string, email: string): void {
  const matchingRefreshes: Array<[string, RefreshTokenEntry]> = [];
  for (const entry of refreshTokens.entries()) {
    if (entry[1].client_id === clientId && entry[1].email === email) {
      matchingRefreshes.push(entry);
    }
  }
  if (matchingRefreshes.length < MAX_TOKENS_PER_CLIENT_USER) return;

  matchingRefreshes.sort((a, b) => a[1].created_at - b[1].created_at);
  const toEvict = matchingRefreshes.slice(0, matchingRefreshes.length - MAX_TOKENS_PER_CLIENT_USER + 1);
  for (const [hash, rt] of toEvict) {
    if (rt.access_token_hash) {
      tokens.delete(rt.access_token_hash);
      deleteAccessTokenByHash(rt.access_token_hash);
    }
    refreshTokens.delete(hash);
    deleteRefreshTokenByHash(hash);
  }
  console.error(
    `[academy-oauth] per-client-user cap: client=${clientId} email=${email} ` +
    `evicted=${toEvict.length}`,
  );
}

// ─── Bootstrap ───────────────────────────────────────────────────────

export async function hydrateOAuthState(): Promise<{
  clients: number; authCodes: number; tokens: number; refreshTokens: number; magicLinks: number;
}> {
  const state = await loadOAuthStateFromDb();
  for (const [k, v] of state.clients) clients.set(k, v as Client);
  // Tokens / codes / magic-links: DB rows use HASH as primary key already, so
  // we hydrate hash-keyed Maps 1:1.
  for (const [hash, v] of state.authCodes) authCodes.set(hash, v as AuthCode);
  // family_id IS persisted here (schema.sql has the column), unlike in the
  // reference implementation. There, a restart handed every rehydrated token a
  // fresh `legacy_*` family, which silently disabled replay detection for the
  // remaining lifetime of every token minted before the restart — and restarts
  // happen on every deploy. The `?? legacy_` fallback below only covers rows
  // written before this column existed; those age out within the refresh TTL.
  for (const [hash, v] of state.accessTokens) {
    const at = v as {
      client_id: string; email: string; family_id?: string; created_at: number; expires_at: number;
    };
    tokens.set(hash, {
      client_id: at.client_id,
      email: at.email,
      family_id: at.family_id ?? `legacy_${hash.slice(0, 16)}`,
      created_at: at.created_at,
      expires_at: at.expires_at,
    });
  }
  for (const [hash, v] of state.refreshTokens) {
    // PersistedRefreshToken.access_token IS the hash (persistence layer hashed at save-time).
    const rt = v as {
      client_id: string; email: string; access_token: string; family_id?: string;
      created_at: number; expires_at: number;
    };
    refreshTokens.set(hash, {
      client_id: rt.client_id,
      email: rt.email,
      access_token_hash: rt.access_token,
      family_id: rt.family_id ?? `legacy_${hash.slice(0, 16)}`,
      created_at: rt.created_at,
      expires_at: rt.expires_at,
    });
  }
  for (const [hash, v] of state.magicLinks) magicLinks.set(hash, v as MagicLink);
  return {
    clients: state.clients.length,
    authCodes: state.authCodes.length,
    tokens: state.accessTokens.length,
    refreshTokens: state.refreshTokens.length,
    magicLinks: state.magicLinks.length,
  };
}

export function startOAuthCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      const now = Date.now();
      for (const [h, v] of authCodes.entries()) if (v.expires_at < now) { authCodes.delete(h); deleteAuthCodeByHash(h); }
      for (const [h, v] of tokens.entries()) if (v.expires_at < now) { tokens.delete(h); deleteAccessTokenByHash(h); }
      for (const [h, v] of refreshTokens.entries()) if (v.expires_at < now) { refreshTokens.delete(h); deleteRefreshTokenByHash(h); }
      for (const [h, v] of magicLinks.entries()) if (v.expires_at < now) { magicLinks.delete(h); deleteMagicLinkByHash(h); }
      // Tombstone TTL = REFRESH_TTL_MS (a replay >30d after rotation is moot).
      for (const [h, tomb] of revokedRefreshTombstone.entries()) {
        if (now - tomb.revoked_at > REFRESH_TTL_MS) revokedRefreshTombstone.delete(h);
      }
      await cleanupExpiredOAuthState();
      await cleanupExpiredProviderStates();
    })().catch((err) => console.error("[academy-oauth] cleanup failed:", err));
  }, 5 * 60_000).unref();
}

/**
 * Helper fuer den Social-Callback-Pfad: auth_code an die originale
 * Client-PKCE binden (der Client tauscht mit seinem eigenen code_verifier —
 * gleicher Weg wie beim Magic-Link).
 */
export async function issueAuthCodeForSocial(opts: {
  client_id: string;
  redirect_uri: string;
  pkce_challenge: string;
  email: string;
}): Promise<string> {
  const authCodePlain = randomBytes(32).toString("base64url");
  const authCodeHash = hashToken(authCodePlain);
  const code: AuthCode = {
    client_id: opts.client_id,
    redirect_uri: opts.redirect_uri,
    code_challenge: opts.pkce_challenge,
    email: normalizeEmail(opts.email),
    expires_at: Date.now() + AUTH_CODE_TTL_MS,
  };
  authCodes.set(authCodeHash, code);
  saveAuthCode(authCodePlain, code);
  return authCodePlain;
}

// ─── Body parsers ────────────────────────────────────────────────────

const MAX_OAUTH_BODY = 64 * 1024;

function parseJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_OAUTH_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

function parseForm(req: IncomingMessage): Promise<{ get(key: string): string | null }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const empty = { get: () => null };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_OAUTH_BODY) { req.destroy(); resolve(empty); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      resolve({ get: (k: string) => params.get(k) });
    });
    req.on("error", () => resolve(empty));
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Re-Export der kanonischen Implementierung (src/core/client-ip.ts).
 * Der frueher hier inline stehende `X-Forwarded-For`-Griff war spoofbar und
 * damit die Wurzel von Fable-R1 #2 (alle IP-Limits umgehbar + OOM-Vektor).
 */
export const clientIp = resolveClientIp;

// ─── Bearer auth (exposed for http-server) ──────────────────────────

export interface BearerAuthOk { ok: true; email: string }
export interface BearerAuthFail { ok: false; error: string }

export function checkBearerToken(req: IncomingMessage): BearerAuthOk | BearerAuthFail {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return { ok: false, error: "missing_bearer" };
  const raw = auth.slice(7).trim();
  if (!raw) return { ok: false, error: "empty_token" };

  const hash = hashToken(raw);
  const entry = tokens.get(hash);
  if (!entry) return { ok: false, error: "invalid_token" };
  if (entry.expires_at < Date.now()) {
    tokens.delete(hash);
    deleteAccessTokenByHash(hash);
    return { ok: false, error: "token_expired" };
  }
  return { ok: true, email: entry.email };
}

// ─── Router ──────────────────────────────────────────────────────────

export async function handleOAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url?.split("?")[0];

  if ((url === "/.well-known/oauth-protected-resource" || url === "/.well-known/oauth-protected-resource/mcp") && req.method === "GET") {
    return protectedResourceMetadata(res);
  }
  if ((url === "/.well-known/oauth-authorization-server" || url === "/.well-known/oauth-authorization-server/mcp") && req.method === "GET") {
    return authServerMetadata(res);
  }
  if (url === "/register" && req.method === "POST") {
    if (rateLimit(req, res, "register", RATE_LIMIT_MAX_REGISTER)) return true;
    return register(req, res);
  }
  if (url === "/authorize" && req.method === "GET") return authorizePage(req, res);
  if (url === "/authorize" && req.method === "POST") {
    if (rateLimit(req, res, "authorize", RATE_LIMIT_MAX_AUTH)) return true;
    return authorizeSubmit(req, res);
  }
  if (url === "/authorize/verify" && req.method === "GET") {
    if (rateLimit(req, res, "verify", RATE_LIMIT_MAX_VERIFY)) return true;
    return magicLinkVerify(req, res);
  }
  // Social-Login routes — one regex covers all 4 (google|discord) × (start|callback).
  const socialMatch = url ? /^\/authorize\/(google|discord)(\/callback)?$/.exec(url) : null;
  if (socialMatch && req.method === "GET") {
    const provider = socialMatch[1];
    if (!isProvider(provider)) return false;
    const isCallback = socialMatch[2] === "/callback";
    if (isCallback) {
      if (rateLimit(req, res, `social-cb-${provider}`, RATE_LIMIT_MAX_VERIFY)) return true;
      await socialCallback(provider, req, res, {
        clients,
        issueAuthCode: issueAuthCodeForSocial,
      });
      return true;
    }
    if (rateLimit(req, res, `social-${provider}`, RATE_LIMIT_MAX_AUTH)) return true;
    await socialStart(provider, req, res, {
      clients,
      issueAuthCode: issueAuthCodeForSocial,
    });
    return true;
  }
  if (url === "/token" && req.method === "POST") {
    if (rateLimit(req, res, "token", RATE_LIMIT_MAX_TOKEN)) return true;
    return tokenEndpoint(req, res);
  }
  if (url === "/revoke" && req.method === "POST") return revoke(req, res);
  return false;
}

function protectedResourceMetadata(res: ServerResponse): boolean {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300" });
  res.end(JSON.stringify({
    resource: baseUrl(),
    authorization_servers: [baseUrl()],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
  }));
  return true;
}

function authServerMetadata(res: ServerResponse): boolean {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=300" });
  res.end(JSON.stringify({
    issuer: baseUrl(),
    authorization_endpoint: `${baseUrl()}/authorize`,
    token_endpoint: `${baseUrl()}/token`,
    registration_endpoint: `${baseUrl()}/register`,
    revocation_endpoint: `${baseUrl()}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:read", "mcp:write"],
  }));
  return true;
}

async function register(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // Global cap defense + TOCTOU-safe counter.
  if (clients.size + pendingClientRegistrations >= MAX_CLIENTS) {
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "60" });
    res.end(JSON.stringify({ error: "service_unavailable", error_description: "DCR capacity exhausted; retry later" }));
    console.error(`[academy-oauth] DCR rejected — cap ${MAX_CLIENTS} reached (in-flight=${pendingClientRegistrations})`);
    return true;
  }
  pendingClientRegistrations++;
  try {
    return await registerInner(req, res);
  } finally {
    pendingClientRegistrations--;
  }
}

async function registerInner(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await parseJson(req);
  const name = (body?.client_name as string) || "MCP Client";
  const rawRedirects = Array.isArray(body?.redirect_uris) ? body.redirect_uris as unknown[] : [];

  // redirect_uris is REQUIRED + every entry must be valid (https / localhost-http
  // / mcp-native scheme). Kein Open-Redirect via Empty-List-Fallback.
  if (rawRedirects.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array" }));
    return true;
  }
  if (rawRedirects.length > 8) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_redirect_uri", error_description: "max 8 redirect_uris per client" }));
    return true;
  }
  const redirectUris: string[] = [];
  for (const r of rawRedirects) {
    if (typeof r !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_redirect_uri", error_description: "redirect_uris must be strings" }));
      return true;
    }
    if (!isValidRedirectUri(r)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "invalid_redirect_uri",
        error_description: `${r} is not an allowed redirect target (https, localhost-http, or claude://chatgpt://mcp://cursor://)`,
      }));
      return true;
    }
    redirectUris.push(r);
  }

  const clientId = `academy_client_${randomBytes(16).toString("hex")}`;
  const client: Client = {
    client_id: clientId,
    client_name: name.slice(0, 200),
    redirect_uris: redirectUris,
    created_at: Date.now(),
  };
  clients.set(clientId, client);
  saveClient(client);

  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    client_id: clientId,
    client_name: client.client_name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }));
  console.error(`[academy-oauth] client registered: ${clientId} (${client.client_name}) from ${clientIp(req)}`);
  return true;
}

function authorizePage(req: IncomingMessage, res: ServerResponse): boolean {
  const fullUrl = new URL(req.url!, baseUrl());
  const clientId = fullUrl.searchParams.get("client_id") || "";
  const redirectUri = fullUrl.searchParams.get("redirect_uri") || "";
  const state = fullUrl.searchParams.get("state") || "";
  const codeChallenge = fullUrl.searchParams.get("code_challenge") || "";

  const client = clients.get(clientId);
  if (!client) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Unknown client_id — register via POST /register first");
    return true;
  }
  // Strict redirect_uri match. Empty registered list is not possible because
  // /register rejects empty arrays.
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("redirect_uri not registered for this client");
    return true;
  }
  // PKCE is mandatory — reject if absent.
  if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("code_challenge required (PKCE S256, 43-128 chars)");
    return true;
  }

  const locale = detectLocale(req, baseUrl());
  const providers = enabledProviders();
  const qsBase = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    ...(state ? { state } : {}),
  }).toString();

  const providerButton = (p: Provider): string => {
    if (!providers.includes(p)) return "";
    const label = p === "google" ? t("continue_with_google", locale) : t("continue_with_discord", locale);
    const icon = p === "google" ? GOOGLE_ICON_SVG : DISCORD_ICON_SVG;
    return `<a class="social-btn social-btn--${p}" href="/authorize/${p}?${qsBase}" rel="noopener">${icon}<span>${esc(label)}</span></a>`;
  };

  const providerButtons = providers.length > 0
    ? `<div class="social">${providerButton("google")}${providerButton("discord")}</div>
<div class="or">${esc(t("or_with_email", locale))}</div>`
    : `<div class="divider"></div>`;

  // Familien-Design (S1909): 1:1 portiert aus mcp-nex saas/oauth.ts — dunkle
  // Glass-Card, "studio meyer."-Wortmarke, Gold #C9A96E. Der S1816-Stand hatte
  // ein eigenes helles Layout gebaut; der Login sieht jetzt aus wie bei
  // memory/crm/geo — ein Produkthaus, eine Anmeldung.
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!DOCTYPE html>
<html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>StudioMeyer Academy — ${esc(t("signin_title", locale))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Plus+Jakarta+Sans:wght@300;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:1rem;padding:40px;max-width:440px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.4),0 0 40px rgba(245,235,220,0.02)}
.brand{margin-bottom:18px;opacity:0.85}
.brand svg{display:block;height:14px;width:auto}
h1{font-family:'Plus Jakarta Sans',system-ui,sans-serif;font-size:1.5rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:4px}
.subtitle{color:#b5b5b5;margin-bottom:24px;font-size:0.9rem;line-height:1.5}
.consent{background:rgba(201,169,110,0.04);border:1px solid rgba(201,169,110,0.12);border-radius:12px;padding:16px 18px;margin-bottom:24px}
.consent h2{font-family:'Plus Jakarta Sans',system-ui,sans-serif;font-size:0.75rem;color:rgba(201,169,110,0.7);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px;font-weight:600}
.scope{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:0.88rem}
.scope-icon{color:#C9A96E;font-size:0.7rem}
.scope-label{color:#d4d4d4}
.social{display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.social-btn{display:flex;align-items:center;justify-content:center;gap:10px;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#fafafa;text-decoration:none;font-size:0.92rem;font-weight:500;transition:all 200ms}
.social-btn:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.2)}
.social-btn svg{flex-shrink:0}
.social-btn--google:hover{background:rgba(66,133,244,0.1);border-color:rgba(66,133,244,0.3)}
.social-btn--discord svg{color:#5865F2}
.social-btn--discord:hover{background:rgba(88,101,242,0.12);border-color:rgba(88,101,242,0.4)}
.or{display:flex;align-items:center;gap:12px;color:#525252;font-size:0.78rem;margin:6px 0 14px;text-transform:uppercase;letter-spacing:0.08em}
.or::before,.or::after{content:'';flex:1;height:1px;background:rgba(255,255,255,0.06)}
.divider{height:1px;background:rgba(255,255,255,0.06);margin:20px 0}
label{display:block;margin-bottom:6px;font-size:0.85rem;color:#b5b5b5;font-weight:500}
input[type=email]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#fafafa;font-size:0.95rem;font-family:'Inter',system-ui,sans-serif;margin-bottom:16px;outline:none;transition:border-color 250ms}
input[type=email]:focus{border-color:rgba(201,169,110,0.4);box-shadow:0 0 0 3px rgba(201,169,110,0.08)}
input[type=email]::placeholder{color:#525252}
button{width:100%;padding:13px;border-radius:10px;border:none;background:#C9A96E;color:#0a0a0a;font-size:0.95rem;font-weight:700;font-family:'Plus Jakarta Sans',system-ui,sans-serif;cursor:pointer;transition:all 250ms;letter-spacing:-0.01em}
button:hover{background:#B2963A;box-shadow:0 0 24px rgba(201,169,110,0.2)}
.footer{color:#525252;font-size:0.72rem;text-align:center;margin-top:18px;line-height:1.5}
.footer a{color:#C9A96E;text-decoration:none}
</style></head><body>
<div class="card">
<div class="brand"><svg viewBox="0 0 420 50" xmlns="http://www.w3.org/2000/svg" aria-label="StudioMeyer"><text x="0" y="38" font-family="'Plus Jakarta Sans', sans-serif" font-weight="300" font-size="40" letter-spacing="3" fill="#f5efe6">studio meyer<tspan font-weight="600" fill="#c9a96e">.</tspan></text></svg></div>
<h1>StudioMeyer Academy</h1>
<p class="subtitle">${esc(t("signin_subtitle", locale))}</p>
<div class="consent">
<h2>${esc(t("permissions_header", locale))}</h2>
<div class="scope"><span class="scope-icon">&#9679;</span><span class="scope-label">${esc(t("permission_course", locale))}</span></div>
<div class="scope"><span class="scope-icon">&#9679;</span><span class="scope-label">${esc(t("permission_progress", locale))}</span></div>
<div class="scope"><span class="scope-icon">&#9679;</span><span class="scope-label">${esc(t("permission_tutor", locale))}</span></div>
</div>
${providerButtons}
<form method="POST" action="/authorize">
<input type="hidden" name="client_id" value="${esc(clientId)}">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
<input type="hidden" name="state" value="${esc(state)}">
<input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
<label for="email">${esc(t("email_label", locale))}</label>
<input type="email" id="email" name="email" placeholder="${esc(t("email_placeholder", locale))}" required>
<button type="submit">${esc(t("send_magic_link", locale))}</button>
</form>
<p class="footer">${esc(t("footer_powered", locale))} <a href="https://studiomeyer.io">StudioMeyer</a> &middot; ${esc(t("footer_privacy", locale))}</p>
</div></body></html>`);
  return true;
}

// Brand SVG icons inlined to keep the login page a single HTML response.
const GOOGLE_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M16.51 8.18c0-.57-.05-1.11-.15-1.64H9v3.1h4.21c-.18.98-.73 1.81-1.56 2.37v1.97h2.52c1.47-1.36 2.34-3.36 2.34-5.8z"/><path fill="#34A853" d="M9 17c2.11 0 3.88-.7 5.17-1.89l-2.52-1.97c-.7.47-1.59.75-2.65.75-2.04 0-3.76-1.38-4.38-3.23H1.96v2.04C3.24 15.16 5.93 17 9 17z"/><path fill="#FBBC04" d="M4.62 10.66c-.16-.47-.25-.97-.25-1.49 0-.52.09-1.02.25-1.49V5.64H1.96A8.01 8.01 0 0 0 1 9.18c0 1.29.31 2.5.86 3.55l2.76-2.07z"/><path fill="#EA4335" d="M9 4.21c1.15 0 2.18.4 2.99 1.17l2.24-2.24C12.88 1.93 11.11 1.18 9 1.18 5.93 1.18 3.24 3.02 1.96 5.64l2.76 2.04C5.24 5.59 6.96 4.21 9 4.21z"/></svg>`;
const DISCORD_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 71 55" xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M60.1 4.9A58.5 58.5 0 0 0 45.7.5a40.7 40.7 0 0 0-1.9 3.8 54 54 0 0 0-16.2 0A39.7 39.7 0 0 0 25.6.5 58.3 58.3 0 0 0 11.2 4.9C2 18.8-.5 32.4.8 45.7a58.7 58.7 0 0 0 17.9 9 43.4 43.4 0 0 0 3.8-6.2 38 38 0 0 1-6-2.9c.5-.4 1-.7 1.5-1.1a41.8 41.8 0 0 0 35.6 0c.5.4 1 .8 1.5 1.1a37.9 37.9 0 0 1-6 2.9 43.5 43.5 0 0 0 3.8 6.2 58.5 58.5 0 0 0 17.9-9C72.1 30.3 68 16.9 60.1 4.9zM23.7 37.7c-3.5 0-6.4-3.3-6.4-7.3s2.9-7.3 6.4-7.3 6.5 3.3 6.4 7.3c.1 4-2.9 7.3-6.4 7.3zm23.6 0c-3.5 0-6.4-3.3-6.4-7.3s2.9-7.3 6.4-7.3 6.5 3.3 6.4 7.3c.1 4-2.9 7.3-6.4 7.3z"/></svg>`;

async function authorizeSubmit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const form = await parseForm(req);
  const email = normalizeEmail(form.get("email") || "");
  const clientId = form.get("client_id") || "";
  const redirectUri = form.get("redirect_uri") || "";
  const state = form.get("state") || "";
  const codeChallenge = form.get("code_challenge") || "";
  const locale = detectLocale(req, baseUrl());

  if (!isValidEmail(email)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("invalid_email");
    return true;
  }
  const client = clients.get(clientId);
  if (!client) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("unknown_client");
    return true;
  }
  // Re-check strict redirect_uri match here, so a tampered form-body can't
  // substitute a different redirect_uri that the GET page rejected.
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("redirect_uri not registered for this client");
    return true;
  }
  if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("code_challenge required (PKCE S256, 43-128 chars)");
    return true;
  }

  // Suspended-User check + Bekanntheit in EINEM Lookup (der 60s-Cache macht
  // beide Aufrufe praktisch gratis). Unbekannte Emails sind erlaubt — sie
  // legen beim Verify eine User-Row an. Die Antwortseite ist immer dieselbe,
  // sonst waere die Sperre ein Enumerations-Oracle.
  const existingUser = await getUserByEmail(email);
  if (existingUser?.suspended) return renderCheckEmailPage(res, locale, email);

  // Empfaenger-Budget (R1 #1 CRITICAL): der IP-Limiter allein schuetzt FREMDE
  // Postfaecher nicht — er begrenzt den Absender, nicht das Ziel. Cooldown +
  // Tages-Cap haengen deshalb an der Adresse, das globale Spray-Budget nur an
  // UNBEKANNTEN Empfaengern (R3 #1: sonst sperrt ein Spray echte Kunden aus).
  const mailBudget = checkMagicLinkMailBudget(email, {
    knownRecipient: Boolean(existingUser),
    requesterIp: clientIp(req),
  });
  if (!mailBudget.ok) {
    console.error(
      `[academy-oauth] magic-link mail budget exhausted for recipient (retry_after=${mailBudget.retry_after_seconds ?? "?"}s)`,
    );
    return renderCheckEmailPage(res, locale, email);
  }

  const tokenPlain = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(tokenPlain);
  const link: MagicLink = {
    email,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    expires_at: Date.now() + MAGIC_LINK_TTL_MS,
  };
  magicLinks.set(tokenHash, link);
  saveMagicLink(tokenPlain, link);

  const verifyUrl = `${baseUrl()}/authorize/verify?token=${encodeURIComponent(tokenPlain)}`;
  try {
    await sendMagicLinkEmail(email, verifyUrl);
  } catch (err) {
    console.error(`[academy-oauth] sendMagicLinkEmail failed for ${email}:`, err);
  }

  return renderCheckEmailPage(res, locale, email);
}


function renderCheckEmailPage(res: ServerResponse, locale: Parameters<typeof t>[1], email: string): boolean {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    brandedPageShell(
      locale,
      t("email_sent_title", locale),
      `<div class="icon">&#9993;</div>
<h2>${esc(t("email_sent_title", locale))}</h2>
<p>${esc(t("email_sent_to", locale))}<br><span class="email">${esc(email)}</span></p>
<p>${esc(t("email_sent_body", locale))}</p>
<p class="hint">${esc(t("email_sent_hint", locale))}</p>`,
    ),
  );
  return true;
}

async function magicLinkVerify(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const fullUrl = new URL(req.url!, baseUrl());
  const tokenPlain = fullUrl.searchParams.get("token") || "";
  if (!tokenPlain) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("invalid_or_expired_link");
    return true;
  }
  const tokenHash = hashToken(tokenPlain);
  const link = magicLinks.get(tokenHash);
  if (!link) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("invalid_or_expired_link");
    return true;
  }
  if (link.expires_at < Date.now()) {
    magicLinks.delete(tokenHash);
    deleteMagicLinkByHash(tokenHash);
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("link_expired");
    return true;
  }

  // Single-use
  magicLinks.delete(tokenHash);
  deleteMagicLinkByHash(tokenHash);

  // Sperre ERNEUT pruefen (Fable-R1 #7): zwischen Mail-Versand und Klick
  // koennen Minuten liegen — wird der Account in dieser Zeit gesperrt, darf
  // der Link keinen auth_code mehr minten.
  if (!(await isUserAllowed(link.email))) {
    res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("account_suspended");
    console.error(`[academy-oauth] magic-link verify blocked — account suspended`);
    return true;
  }

  // Auto-create user + mark verified
  try {
    await upsertUser(link.email);
    await markUserEmailVerified(link.email);
  } catch (err) {
    console.error(`[academy-oauth] upsertUser failed for ${link.email}:`, err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("user_provisioning_failed");
    return true;
  }

  const authCodePlain = randomBytes(32).toString("base64url");
  const authCodeHash = hashToken(authCodePlain);
  const code: AuthCode = {
    client_id: link.client_id,
    redirect_uri: link.redirect_uri,
    code_challenge: link.code_challenge,
    email: link.email,
    expires_at: Date.now() + AUTH_CODE_TTL_MS,
  };
  authCodes.set(authCodeHash, code);
  saveAuthCode(authCodePlain, code);

  if (link.redirect_uri) {
    const sep = link.redirect_uri.includes("?") ? "&" : "?";
    const stateQs = link.state ? `&state=${encodeURIComponent(link.state)}` : "";
    res.writeHead(302, {
      Location: `${link.redirect_uri}${sep}code=${encodeURIComponent(authCodePlain)}${stateQs}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
  } else {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(
      brandedPageShell(
        "de",
        "Erfolgreich verbunden",
        `<div class="icon">&#10003;</div>
<h2>Erfolgreich verbunden</h2>
<p>Dein Authorization-Code:</p>
<pre>${esc(authCodePlain)}</pre>
<p>Paste den Code in deinen MCP-Client.</p>`,
      ),
    );
  }
  console.error(`[academy-oauth] magic-link verified: ${link.email} (client ${link.client_id})`);
  return true;
}

async function tokenEndpoint(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const form = await parseForm(req);
  const grantType = form.get("grant_type") || "";
  if (grantType === "authorization_code") return authCodeGrant(form, res);
  if (grantType === "refresh_token") return refreshGrant(form, res);
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unsupported_grant_type" }));
  return true;
}

/**
 * PKCE code_verifier ABNF check (RFC 7636 §4.1):
 *   code-verifier = 43*128unreserved
 *   unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
 */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function authCodeGrant(form: { get(k: string): string | null }, res: ServerResponse): boolean {
  const codePlain = form.get("code") || "";
  const codeVerifier = form.get("code_verifier") || "";
  const clientId = form.get("client_id") || "";
  // Optional per RFC 6749 (only required when it was in the authorize request,
  // which for us it always is) — compared further down, after the code lookup.
  const redirectUri = form.get("redirect_uri") ?? undefined;

  // Reject malformed PKCE verifier BEFORE looking up the code — saves the
  // delete-first consumption when the input was junk anyway.
  if (!PKCE_VERIFIER_RE.test(codeVerifier)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "invalid_grant",
      error_description: "code_verifier must match RFC 7636 ABNF (43-128 unreserved chars)",
    }));
    return true;
  }

  const codeHash = hashToken(codePlain);
  const entry = authCodes.get(codeHash);
  if (!entry) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "code not found" }));
    return true;
  }

  // Single-use: consume the auth-code BEFORE any validation. Ein gescheiterter
  // PKCE-/client_id-Check darf den Code nicht im Map lassen (kein Guessing).
  authCodes.delete(codeHash);
  deleteAuthCodeByHash(codeHash);

  if (entry.client_id !== clientId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "client_id mismatch" }));
    return true;
  }
  if (entry.expires_at < Date.now()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "code_expired" }));
    return true;
  }

  // redirect_uri must match the one the code was issued for (RFC 6749 §4.1.3).
  // The reference implementation stores this value and never compares it —
  // PKCE plus the exact-match at /authorize cover the main attack, but a
  // mismatching redirect_uri is still a sign that something is off, and the
  // spec asks for the check. Two lines, so we do it.
  if (redirectUri !== undefined && redirectUri !== entry.redirect_uri) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri mismatch" }));
    return true;
  }

  // PKCE S256 check (timing-safe).
  const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(expectedChallenge);
  const b = Buffer.from(entry.code_challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "pkce_mismatch" }));
    return true;
  }

  // Per-(client_id, email) token cap before mint.
  enforceTokenPerClientUserCap(clientId, entry.email);

  // Fresh token-family for this auth-code grant.
  const familyId = randomBytes(16).toString("hex");

  const accessTokenPlain = `academy_at_${randomBytes(24).toString("base64url")}`;
  const refreshTokenPlain = `academy_rt_${randomBytes(24).toString("base64url")}`;
  const accessTokenHash = hashToken(accessTokenPlain);
  const refreshTokenHash = hashToken(refreshTokenPlain);
  const at: AccessToken = {
    client_id: clientId,
    email: entry.email,
    family_id: familyId,
    created_at: Date.now(),
    expires_at: Date.now() + TOKEN_TTL_MS,
  };
  const rt: RefreshTokenEntry = {
    client_id: clientId,
    email: entry.email,
    access_token_hash: accessTokenHash,
    family_id: familyId,
    created_at: Date.now(),
    expires_at: Date.now() + REFRESH_TTL_MS,
  };
  tokens.set(accessTokenHash, at);
  refreshTokens.set(refreshTokenHash, rt);
  saveAccessToken(accessTokenPlain, at);
  // The persistence layer hashes `access_token` again when storing the row.
  saveRefreshToken(refreshTokenPlain, {
    client_id: clientId,
    email: entry.email,
    access_token: accessTokenPlain,
    created_at: rt.created_at,
    expires_at: rt.expires_at,
  });

  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({
    access_token: accessTokenPlain,
    token_type: "Bearer",
    expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    refresh_token: refreshTokenPlain,
    scope: "mcp:read mcp:write",
  }));
  return true;
}

async function refreshGrant(form: { get(k: string): string | null }, res: ServerResponse): Promise<boolean> {
  const refreshTokenPlain = form.get("refresh_token") || "";
  const clientId = form.get("client_id") || "";
  const refreshTokenHash = hashToken(refreshTokenPlain);

  // Mutex keyed by HASH so racing requests with the same plaintext token coalesce.
  const inFlight = refreshInFlight.get(refreshTokenHash);
  if (inFlight) {
    const result = await inFlight;
    return sendRefreshResult(res, result);
  }
  const promise = doRefresh(refreshTokenHash, clientId);
  refreshInFlight.set(refreshTokenHash, promise);
  try {
    const result = await promise;
    return sendRefreshResult(res, result);
  } finally {
    refreshInFlight.delete(refreshTokenHash);
  }
}

async function doRefresh(refreshTokenHash: string, clientId: string): Promise<RefreshResult> {
  // Replay-detection: sitzt der Hash im Tombstone, wurde das Token bereits
  // durch eine Rotation verbraucht → starkes Diebstahl-Signal → GANZE
  // Familie revoken (alle gepaarten Access- + Refresh-Tokens).
  const tombstone = revokedRefreshTombstone.get(refreshTokenHash);
  if (tombstone) {
    revokeEntireFamily(tombstone.family_id, "replay_of_consumed_refresh_token");
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "refresh_token reused — family revoked. Re-authenticate.",
      },
    };
  }

  const entry = refreshTokens.get(refreshTokenHash);
  if (!entry) return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "refresh not found" } };
  if (entry.client_id !== clientId) return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "client_id mismatch" } };
  if (entry.expires_at < Date.now()) {
    refreshTokens.delete(refreshTokenHash);
    deleteRefreshTokenByHash(refreshTokenHash);
    return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "refresh_expired" } };
  }

  // Rotate: invalidate paired access-token + the refresh itself BEFORE minting
  // new ones. Tombstone the old refresh-hash so replay is detected.
  if (entry.access_token_hash) {
    tokens.delete(entry.access_token_hash);
    deleteAccessTokenByHash(entry.access_token_hash);
  }
  refreshTokens.delete(refreshTokenHash);
  deleteRefreshTokenByHash(refreshTokenHash);
  revokedRefreshTombstone.set(refreshTokenHash, {
    family_id: entry.family_id,
    revoked_at: Date.now(),
  });

  const newAccessPlain = `academy_at_${randomBytes(24).toString("base64url")}`;
  const newRefreshPlain = `academy_rt_${randomBytes(24).toString("base64url")}`;
  const newAccessHash = hashToken(newAccessPlain);
  const newRefreshHash = hashToken(newRefreshPlain);
  const at: AccessToken = {
    client_id: clientId,
    email: entry.email,
    family_id: entry.family_id, // inherit family — same chain of trust
    created_at: Date.now(),
    expires_at: Date.now() + TOKEN_TTL_MS,
  };
  const rt: RefreshTokenEntry = {
    client_id: clientId,
    email: entry.email,
    access_token_hash: newAccessHash,
    family_id: entry.family_id, // inherit
    created_at: Date.now(),
    expires_at: Date.now() + REFRESH_TTL_MS,
  };
  tokens.set(newAccessHash, at);
  refreshTokens.set(newRefreshHash, rt);
  saveAccessToken(newAccessPlain, at);
  saveRefreshToken(newRefreshPlain, {
    client_id: clientId,
    email: entry.email,
    access_token: newAccessPlain,
    created_at: rt.created_at,
    expires_at: rt.expires_at,
  });

  return {
    ok: true,
    accessToken: newAccessPlain,
    refreshToken: newRefreshPlain,
    clientId,
    email: entry.email,
    expiresInSec: Math.floor(TOKEN_TTL_MS / 1000),
  };
}

function sendRefreshResult(res: ServerResponse, result: RefreshResult): boolean {
  if (result.ok) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresInSec,
      refresh_token: result.refreshToken,
      scope: "mcp:read mcp:write",
    }));
  } else {
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  }
  return true;
}

async function revoke(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const form = await parseForm(req);
  const tokenPlain = form.get("token") || "";
  const clientId = form.get("client_id") || "";

  // RFC 7009 §2.1: die Revocation braucht einen Client-Bezug (client_id als
  // Soft-Proof; ohne ihn koennte jeder Token-Kenner fremde Tokens revoken).
  // Per RFC 7009 §2.2 antworten wir IMMER 200 — kein Existenz-Leak.
  if (!clientId) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (tokenPlain) {
    const tokenHash = hashToken(tokenPlain);

    const at = tokens.get(tokenHash);
    if (at && at.client_id === clientId) {
      tokens.delete(tokenHash);
      deleteAccessTokenByHash(tokenHash);
    }

    const rt = refreshTokens.get(tokenHash);
    if (rt && rt.client_id === clientId) {
      if (rt.access_token_hash) {
        tokens.delete(rt.access_token_hash);
        deleteAccessTokenByHash(rt.access_token_hash);
      }
      refreshTokens.delete(tokenHash);
      deleteRefreshTokenByHash(tokenHash);
      // Tombstone the revoked refresh — replay triggert den Family-Revoke.
      revokedRefreshTombstone.set(tokenHash, {
        family_id: rt.family_id,
        revoked_at: Date.now(),
      });
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
  return true;
}

/** Test-only: drop all in-memory state. */
export function __resetOAuthForTest(): void {
  clients.clear();
  authCodes.clear();
  tokens.clear();
  refreshTokens.clear();
  magicLinks.clear();
  refreshInFlight.clear();
  rateLimits.clear();
  revokedRefreshTombstone.clear();
  pendingClientRegistrations = 0;
}

/** Test-only: register a client directly (bypass DCR). */
export function __registerClientForTest(clientId: string, redirectUris: string[]): void {
  clients.set(clientId, {
    client_id: clientId,
    client_name: "test-client",
    redirect_uris: redirectUris,
    created_at: Date.now(),
  });
}

/** Test-only: mint an access token directly for an email (bypass flow). */
export function __mintTokenForTest(email: string, clientId = "test-client"): string {
  const accessTokenPlain = `academy_at_${randomBytes(24).toString("base64url")}`;
  const accessTokenHash = hashToken(accessTokenPlain);
  tokens.set(accessTokenHash, {
    client_id: clientId,
    email,
    family_id: "test-family",
    created_at: Date.now(),
    expires_at: Date.now() + TOKEN_TTL_MS,
  });
  return accessTokenPlain;
}

/** Test-only: mint an auth-code + return plaintext (fuer Token-Flow-Tests). */
export async function __mintAuthCodeForTest(opts: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  email: string;
}): Promise<string> {
  return issueAuthCodeForSocial({
    client_id: opts.client_id,
    redirect_uri: opts.redirect_uri,
    pkce_challenge: opts.code_challenge,
    email: opts.email,
  });
}

/** Test-only: inspect the tombstone size (replay-detection). */
export function __getTombstoneSize(): number {
  return revokedRefreshTombstone.size;
}

/** Test-only: inspect map sizes. */
export function __getOAuthState(): { clients: number; authCodes: number; tokens: number; refreshTokens: number; magicLinks: number; rateLimits: number } {
  return {
    clients: clients.size,
    authCodes: authCodes.size,
    tokens: tokens.size,
    refreshTokens: refreshTokens.size,
    magicLinks: magicLinks.size,
    rateLimits: rateLimits.size,
  };
}
