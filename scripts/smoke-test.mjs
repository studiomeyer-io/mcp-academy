#!/usr/bin/env node
/**
 * smoke-test.mjs — end-to-end check of the built server over BOTH transports.
 * Exit 0 only if all asserts pass.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

const results = [];
let failed = 0;
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failed++;
}

async function rpcStdio(env, requests) {
  const child = spawn("node", ["dist/index.js"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  let errOut = "";
  child.stderr.on("data", (d) => (errOut += d.toString()));
  for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  await sleep(800);
  child.stdin.end();
  await sleep(200);
  child.kill();
  const msgs = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { msgs, errOut };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } };
const INITED = { jsonrpc: "2.0", method: "notifications/initialized" };
const listTools = (id) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
const callTool = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

console.log("=== mcp-academy smoke test ===\n");

// 1) PUBLIC stdio (no API key)
{
  const { msgs, errOut } = await rpcStdio({ ACADEMY_API_KEY: "" }, [
    INIT, INITED, listTools(2),
    callTool(3, "academy_welcome", { locale: "de" }),
    callTool(4, "academy_levels", { locale: "en" }),
    callTool(5, "academy_lessons", { level: 1, locale: "en" }),
    callTool(6, "search", { query: "memory hooks claude code" }),
    callTool(7, "academy_search", { query: "mcp server bauen", locale: "de" }),
  ]);
  const init = msgs.find((m) => m.id === 1);
  check("public/init serverInfo", init?.result?.serverInfo?.name === "mcp-academy", "v" + init?.result?.serverInfo?.version);
  // VERSION lives in src/server.ts as a constant; without this it silently drifts
  // from package.json (it shipped 0.3.0 while package.json said 0.4.0).
  check(
    "version matches package.json",
    init?.result?.serverInfo?.version === PKG_VERSION,
    `server=${init?.result?.serverInfo?.version} package=${PKG_VERSION}`,
  );
  check("public/init has instructions", typeof init?.result?.instructions === "string" && init.result.instructions.includes("academy_welcome"));
  const tools = msgs.find((m) => m.id === 2)?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check("public lists search+fetch", names.includes("search") && names.includes("fetch"), names.length + " tools");
  check("public hides account tools", !names.includes("academy_stats") && !names.includes("academy_quiz_submit"));
  const welcome = msgs.find((m) => m.id === 3)?.result;
  check("academy_welcome text", welcome?.content?.[0]?.text?.includes("Academy"), (welcome?.content?.[0]?.text ?? "").slice(0, 36));
  const levels = JSON.parse(msgs.find((m) => m.id === 4)?.result?.content?.[0]?.text ?? "{}");
  check("academy_levels = 6", (levels.levels ?? []).length === 6);
  const lessons = JSON.parse(msgs.find((m) => m.id === 5)?.result?.content?.[0]?.text ?? "{}");
  check("academy_lessons L1 non-empty", (lessons.lessons ?? []).length > 0, (lessons.lessons ?? []).length + " lessons");
  const srch = msgs.find((m) => m.id === 6)?.result;
  const sres = JSON.parse(srch?.content?.[0]?.text ?? "{}");
  check("search returns results[]", Array.isArray(sres.results) && sres.results.length > 0, (sres.results?.length ?? 0) + " hits");
  check("search result has id/title/url", !!(sres.results?.[0]?.id && sres.results?.[0]?.title && sres.results?.[0]?.url));
  check("search structuredContent", Array.isArray(srch?.structuredContent?.results));
  const acSearch = JSON.parse(msgs.find((m) => m.id === 7)?.result?.content?.[0]?.text ?? "{}");
  check("academy_search ranked", (acSearch.results ?? []).length > 0);
  check("public stderr says public mode", errOut.includes("public"));

  const firstId = sres.results?.[0]?.id;
  if (firstId) {
    const { msgs: m2 } = await rpcStdio({ ACADEMY_API_KEY: "" }, [INIT, INITED, callTool(8, "fetch", { id: firstId })]);
    const doc = JSON.parse(m2.find((m) => m.id === 8)?.result?.content?.[0]?.text ?? "{}");
    check("fetch id/title/text/url", !!(doc.id && doc.title && doc.text && doc.url), "textLen=" + (doc.text?.length ?? 0));
    check("fetch id roundtrips", doc.id === firstId);
  }
}

// 2) FULL stdio (with key) → account tools listed
{
  const { msgs } = await rpcStdio({ ACADEMY_API_KEY: "academy_fake_listing_test" }, [INIT, INITED, listTools(2)]);
  const names = (msgs.find((m) => m.id === 2)?.result?.tools ?? []).map((t) => t.name);
  check("full lists account tools", names.includes("academy_stats") && names.includes("academy_quiz_submit"));
  check("full keeps public tools", names.includes("academy_lesson") && names.includes("search"));
}

// 3) account tool without key → guarded error
{
  const { msgs } = await rpcStdio({ ACADEMY_API_KEY: "" }, [INIT, INITED, callTool(9, "academy_stats", {})]);
  const r = msgs.find((m) => m.id === 9)?.result;
  check(
    "account tool w/o key guarded",
    r?.isError === true && /mcp\.studiomeyer\.academy/.test(r?.content?.[0]?.text ?? ""),
    "points at the hosted course",
  );
}

// 4) HTTP transport — the hosted course. Needs Postgres (OAuth state lives
// there and the server refuses to listen before it has rehydrated). Without a
// database we say so out loud rather than quietly reporting all-green.
if (!process.env.ACADEMY_MCP_DATABASE_URL && !process.env.DATABASE_URL) {
  results.push("SKIP  http transport — set ACADEMY_MCP_DATABASE_URL to cover the course server");
} else {
  const port = 8791;
  const child = spawn("node", ["dist/index.js", "--http"], {
    // ACADEMY_MCP_* — plain PORT/HOST are ignored by core/base-url.ts. Getting
    // this wrong is exactly the bug that would have shipped in the Dockerfile.
    env: {
      ...process.env,
      ACADEMY_MCP_PORT: String(port),
      ACADEMY_MCP_HOST: "127.0.0.1",
      ACADEMY_MCP_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await sleep(1500);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    check("http /health ok", health?.ok === true && health?.mode === "course", "v" + health?.version);

    // The whole point of the hosted server: an unauthenticated call must be a
    // 401 that TELLS the client where to sign in. A 200 here would mean nobody
    // ever discovers the authorization server, and nobody ever signs in.
    const bare = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INIT),
    });
    const wwwAuth = bare.headers.get("www-authenticate") ?? "";
    check("http /mcp unauthenticated → 401", bare.status === 401, "status " + bare.status);
    check(
      "401 carries resource_metadata",
      wwwAuth.includes("resource_metadata=") && wwwAuth.includes("/.well-known/oauth-protected-resource"),
      wwwAuth.slice(0, 80),
    );

    const prm = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`).then((r) => r.json());
    check("protected-resource metadata", Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length > 0);

    const asm = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`).then((r) => r.json());
    check(
      "authorization-server metadata",
      !!asm?.authorization_endpoint && !!asm?.token_endpoint && !!asm?.registration_endpoint,
    );
    check("PKCE S256 advertised", (asm?.code_challenge_methods_supported ?? []).includes("S256"));

    // Claude and ChatGPT append the resource path to the well-known path.
    // Both forms have to answer or discovery breaks for those clients.
    const suffixed = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
    check("well-known also answers under /mcp", suffixed.status === 200, "status " + suffixed.status);

    const bad = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer academy_at_nonsense" },
      body: JSON.stringify(INIT),
    });
    check("invalid bearer → 401", bad.status === 401, "status " + bad.status);
  } catch (e) {
    check("http transport reachable", false, String(e));
  } finally {
    child.kill();
  }
}

console.log(results.join("\n"));
console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${results.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
