#!/usr/bin/env node
/**
 * smoke-test.mjs — end-to-end check of the built server over BOTH transports.
 * Exit 0 only if all asserts pass.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

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
  check("account tool w/o key guarded", r?.isError === true && r?.content?.[0]?.text?.includes("ACADEMY_API_KEY"));
}

// 4) HTTP transport
{
  const port = 8791;
  const child = spawn("node", ["dist/index.js", "--http"], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  await sleep(700);
  async function post(body) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch {
      const line = txt.split("\n").find((l) => l.startsWith("data:"));
      if (line) { try { json = JSON.parse(line.slice(5).trim()); } catch {} }
    }
    return { status: res.status, json, txt: txt.slice(0, 120) };
  }
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    check("http /health ok", health?.ok === true && health?.mode === "public", "v" + health?.version);
    const init = await post(INIT);
    check("http initialize ok", init.json?.result?.serverInfo?.name === "mcp-academy", "status " + init.status);
    const tl = await post(listTools(2));
    const names = (tl.json?.result?.tools ?? []).map((t) => t.name);
    check("http lists search/fetch", names.includes("search") && names.includes("fetch"), names.length + " tools");
    check("http public-only", !names.includes("academy_stats"));
    const s = await post(callTool(3, "search", { query: "spaced repetition review" }));
    const sres = JSON.parse(s.json?.result?.content?.[0]?.text ?? "{}");
    check("http search results", Array.isArray(sres.results) && sres.results.length > 0, (sres.results?.length ?? 0) + " hits");
  } catch (e) {
    check("http transport reachable", false, String(e));
  } finally {
    child.kill();
  }
}

console.log(results.join("\n"));
console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"} (${results.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
