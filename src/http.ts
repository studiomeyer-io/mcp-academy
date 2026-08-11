/**
 * http.ts — the hosted course at mcp.studiomeyer.academy.
 *
 * This is the half of the product that knows who you are. The npm package is
 * the library: the whole curriculum, offline, no account, nobody to be. Here
 * you sign in once and the course remembers you — progress, quizzes, review,
 * certificates. Same lessons, different promise.
 *
 * WHY /mcp ALWAYS DEMANDS A TOKEN. It would be tempting to let unauthenticated
 * callers read lessons here too and only gate the account tools. Two reasons
 * not to. First, it breaks discovery: a client that gets a 200 never learns
 * there is an authorization server, so nobody would ever sign in. The 401 with
 * WWW-Authenticate IS the login button — the server raises it, not the user.
 * Second, anonymous reading already has a home that is better at it: the npm
 * package, which needs no network at all.
 *
 * Request path, in order, because the order is the security:
 *
 *   handleOAuth        the sign-in routes themselves — never behind the token,
 *                      and deliberately NOT behind the origin check either
 *                      (in-app browsers send `Origin: null` and would be
 *                      locked out of the magic-link POST; they are protected
 *                      by rate limits and the mail budget instead)
 *   origin check       only on /mcp
 *   IP rate limit      BEFORE the token check, or the public 401 path is a
 *                      free, unmetered endpoint
 *   401 no bearer      + WWW-Authenticate pointing at the resource metadata
 *   401 bad bearer     same header, different body
 *   block list         a token minted before a block must stop working
 *   user rate limit    keyed on the person, not the address
 *   serve MCP          fresh server + transport per request, bound to the email
 *
 * Env: ACADEMY_MCP_PORT (default 3116), ACADEMY_MCP_HOST (default 127.0.0.1 —
 * it sits behind nginx), MCP_PATH (default /mcp), ACADEMY_MCP_BASE_URL (the
 * public URL, required unless bound to loopback).
 */

import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION } from "./server.js";
import { handleOAuth, checkBearerToken, hydrateOAuthState, startOAuthCleanup } from "./auth/oauth.js";
import { validateEnvAtStartup } from "./core/startup-checks.js";
import { getBaseUrl, getPort, getHost } from "./core/base-url.js";
import { clientIp } from "./core/client-ip.js";
import { checkIpRateLimit, checkUserRateLimit } from "./safety/rate-limit.js";
import { isUserAllowed, touchLastSeen } from "./auth/users.js";

// Host comes from base-url.ts and NOWHERE else. A second copy here used `??`
// where base-url.ts uses `||`: with ACADEMY_MCP_HOST set but EMPTY, this file
// bound to "" (= all interfaces, verified: node listen(0,"") reports "::")
// while assertBaseUrlUsable() asked base-url.ts, got the "127.0.0.1" default,
// concluded "loopback" and waved the missing ACADEMY_MCP_BASE_URL through.
// Result: publicly bound server advertising http://127.0.0.1 in its
// WWW-Authenticate header, metadata documents and magic-link emails.
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

/**
 * Clients that may drive this server from a browser. A request with no Origin
 * at all is allowed — native MCP clients do not send one, and rejecting them
 * would be rejecting almost everybody.
 */
const ALLOWED_ORIGIN_RE =
  /^https:\/\/(claude\.ai|chat\.openai\.com|chatgpt\.com|x\.ai|.*\.cursor\.sh|studiomeyer\.academy|.*\.studiomeyer\.academy|studiomeyer\.io|.*\.studiomeyer\.io)$/;
const LOCALHOST_ORIGIN_RE = /^https?:\/\/localhost(:\d+)?$/;

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGIN_RE.test(origin) || LOCALHOST_ORIGIN_RE.test(origin);
}

function setCommonHeaders(res: ServerResponse, origin: string | undefined): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-session-id, mcp-protocol-version");
    // UPPERCASE is not cosmetic — lowercase breaks Claude.ai and Claude Desktop.
    res.setHeader("Access-Control-Expose-Headers", "MCP-Session-ID, mcp-protocol-version, WWW-Authenticate");
  }
}

/** 401 with the pointer every MCP client follows to find the login. */
function unauthorized(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate":
      `Bearer resource_metadata="${getBaseUrl()}/.well-known/oauth-protected-resource"`,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new Error("payload too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isOriginAllowed(req.headers.origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "origin_not_allowed" }));
    return;
  }

  const ip = clientIp(req);

  // Before the token check on purpose: otherwise the 401 path is an unmetered
  // public endpoint and a flood costs us everything while costing them nothing.
  const ipRate = checkIpRateLimit(ip);
  if (!ipRate.ok) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(ipRate.retry_after_seconds ?? 60) });
    res.end(JSON.stringify({ error: "rate_limited", retry_after: ipRate.retry_after_seconds }));
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    unauthorized(res, {
      error: "auth_required",
      error_description: "Sign in to take the course. The free curriculum is also available offline via `npx -y mcp-academy`.",
      login_url: `${getBaseUrl()}/authorize`,
    });
    return;
  }

  const verdict = checkBearerToken(req);
  if (!verdict.ok) {
    unauthorized(res, { error: "invalid_or_expired_token" });
    return;
  }
  const email = verdict.email;

  // A block applied after the token was minted has to bite immediately —
  // otherwise it takes up to an hour (access) or thirty days (refresh) to land.
  // Fail closed: if we cannot check, we do not serve.
  try {
    if (!(await isUserAllowed(email))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "account_suspended" }));
      return;
    }
  } catch (e) {
    console.error(`[academy-http] block-list check failed (fail-closed):`, e);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "temporarily_unavailable" }));
    return;
  }

  const userRate = checkUserRateLimit(email);
  if (!userRate.ok) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(userRate.retry_after_seconds ?? 60) });
    res.end(JSON.stringify({ error: "rate_limited", retry_after: userRate.retry_after_seconds }));
    return;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  void touchLastSeen(email);

  const body = req.method === "POST" ? await readBody(req) : undefined;
  const server = createServer({ courseFor: email });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function startHttp(): Promise<void> {
  const port = getPort();

  // Everything that must be true before we accept a single request.
  validateEnvAtStartup();

  // Rehydrate BEFORE listen(). If the socket opens first, there is a window in
  // which perfectly valid customer tokens get a 401 while /health reports 200 —
  // measured at several seconds on the sibling server. A failure here throws on
  // purpose (an empty state is indistinguishable from a lost one); the process
  // exits and the container restart policy tries again once the database is up.
  const state = await hydrateOAuthState();
  console.error(
    `[mcp-academy] rehydrated: ${state.clients} clients, ${state.tokens} access tokens`,
  );
  startOAuthCleanup();
  const http = createHttp(async (req, res) => {
    // Everything inside the try, including the URL parse. A malformed Host
    // header or request target makes `new URL()` throw, and outside the try
    // that becomes an unhandled rejection in an async handler — which takes
    // the process down. One bad request should be a 400, not an outage.
    try {
      const origin = req.headers.origin;
      setCommonHeaders(res, origin);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

      // Sign-in routes first, and without the origin guard: in-app browsers
      // (the ones a magic link opens on a phone) send `Origin: null`, and a
      // global guard locked them out of their own login. Learned the hard way
      // on the sibling server; not repeating it here.
      if (await handleOAuth(req, res)) return;

      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true, server: "mcp-academy", version: VERSION,
          transport: "streamable-http", mode: "course", auth: "oauth2.1",
        }));
        return;
      }

      if (url.pathname === MCP_PATH) { await handleMcp(req, res); return; }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", hint: `MCP endpoint is ${MCP_PATH}` }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[academy-http] ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) {
        // Only genuinely malformed input is the caller's fault. Everything else
        // (database down, OAuth layer throwing, SDK failure) is ours, and its
        // message must not leave the process — it names internals.
        // Eng gefasst: nur was der Aufrufer tatsaechlich verursacht haben
        // kann. Ein blankes `instanceof TypeError` faengt auch eigene
        // Programmierfehler ein und meldet sie als 400 — dann sucht man den
        // Bug beim Nutzer statt bei sich.
        const callerFault =
          e instanceof SyntaxError ||                       // kaputtes JSON im Body
          /payload too large|Invalid URL/i.test(message);   // zu gross / krankes Request-Target
        if (callerFault) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_request" }));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        }
      } else {
        res.end();
      }
    }
  });

  http.listen(port, getHost(), () => {
    console.error(`[mcp-academy v${VERSION}] course server on http://${getHost()}:${port}${MCP_PATH} (oauth 2.1)`);
  });

  // Ohne das hier beendet sich der Prozess bei SIGTERM nie von selbst: Docker
  // wartet zehn Sekunden und schiesst dann hart. Gemessen an genau diesem
  // Container — 11s pro Neustart, laufende Anfragen mittendrin abgeschnitten,
  // der Datenbank-Pool nie geschlossen. Bei jedem Deploy.
  //
  // Reihenfolge zaehlt: erst keine neuen Verbindungen mehr annehmen, dann eine
  // kurze Frist fuer das, was noch in der Leitung ist, DANN die Datenbank
  // schliessen. Andersherum laufen die letzten Anfragen in "pool has ended".
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[mcp-academy] ${signal} — fahre herunter`);
    // Notbremse: haengt eine Verbindung, wird trotzdem beendet, statt in den
    // harten Kill zu laufen.
    const force = setTimeout(() => {
      console.error("[mcp-academy] Zeit abgelaufen, beende hart");
      process.exit(1);
    }, 12_000);
    force.unref();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 250));
    try {
      const { closeDb } = await import("./db.js");
      await closeDb();
    } catch { /* beim Herunterfahren nicht mehr wichtig */ }
    clearTimeout(force);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
