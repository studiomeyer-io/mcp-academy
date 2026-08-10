#!/usr/bin/env node
/**
 * mcp-academy — MCP server for StudioMeyer Academy.
 *
 * The free "Memory-First AI Operator" course, takeable inside any MCP client.
 * Two ways to run:
 *
 *   stdio (default) — for Claude Code / Cursor / Claude Desktop / Codex:
 *       npx -y mcp-academy
 *     Add ACADEMY_API_KEY to also unlock your personal progress/quizzes/certs.
 *
 *   http — hosted, anonymous, read-only (powers ChatGPT + remote connectors):
 *       mcp-academy --http        (or MCP_TRANSPORT=http, or set PORT)
 *
 * Content (all 6 levels + playbooks + recipes) is bundled in the package — no
 * DB, no account, no network needed to read the course. Open source, MIT.
 *
 * Env:
 *   ACADEMY_API_KEY   optional. Unlocks account tools (stdio only). "academy_<...>".
 *   ACADEMY_BASE_URL  optional. Default https://studiomeyer.academy.
 *   PORT / HOST / MCP_PATH   http mode only (default 8080 / 127.0.0.1 / /mcp).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
// NOTE: ./http.js is imported DYNAMICALLY below, never at the top. It pulls in
// the whole OAuth layer, which needs `pg` and `nodemailer` — optional
// dependencies that the library half of this package must never require. A
// static import here would make `npx -y mcp-academy` fail on a machine where
// the optional installs did not happen, for a code path it never runs.

const wantHttp =
  process.argv.includes("--http") ||
  process.env.MCP_TRANSPORT === "http" ||
  (!!process.env.PORT && process.env.MCP_TRANSPORT !== "stdio");

async function main() {
  if (wantHttp) {
    if (process.env.ACADEMY_API_KEY) {
      process.stderr.write(
        "[mcp-academy] note: HTTP mode authenticates per person via OAuth; ACADEMY_API_KEY is ignored here (one key cannot stand for every caller).\n",
      );
    }
    const { startHttp } = await import("./http.js");
    await startHttp();
    return;
  }

  const mode = process.env.ACADEMY_API_KEY ? "full" : "public";
  const server = createServer(mode);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[mcp-academy v${VERSION}] stdio (${mode}) ready${mode === "public" ? " — free course, no account needed" : " — account tools enabled"}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[mcp-academy] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
