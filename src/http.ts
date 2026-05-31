/**
 * http.ts — hosts the PUBLIC server over Streamable HTTP (the transport ChatGPT
 * and remote connectors need). Stateless: a fresh transport + server per request,
 * sessionIdGenerator undefined. Anonymous, read-only — no API key is read here,
 * so the hosted endpoint can never serve one person's account to everyone.
 *
 * Env: PORT (default 8080), HOST (default 127.0.0.1, sits behind nginx/Cloudflare),
 *      MCP_PATH (default /mcp).
 */

import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version, authorization");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("payload too large"); // 1MB cap (reads only)
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startHttp(): void {
  const http = createHttp(async (req, res) => {
    cors(res);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: "mcp-academy", version: VERSION, transport: "streamable-http", mode: "public" }));
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", hint: `MCP endpoint is ${MCP_PATH}` }));
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const server = createServer("public");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message }, id: null }));
      }
    }
  });

  http.listen(PORT, HOST, () => {
    process.stderr.write(`[mcp-academy v${VERSION}] HTTP (public) on http://${HOST}:${PORT}${MCP_PATH}\n`);
  });
}
