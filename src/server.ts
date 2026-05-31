/**
 * server.ts — builds a configured MCP Server instance.
 *
 * Two modes:
 *   - "public": account-free. Curriculum reads + search/fetch from the bundle.
 *               Zero config. This is what the hosted HTTP endpoint + `npx mcp-academy`
 *               (no key) expose, and what ChatGPT connects to.
 *   - "full":   public tools PLUS account tools (progress/quiz/certs/tutor) bound
 *               to a personal ACADEMY_API_KEY. stdio only.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PUBLIC_TOOLS, handlePublicTool, PUBLIC_TOOL_NAMES } from "./public-tools.js";
import { ACCOUNT_TOOLS, handleAccountTool, ACCOUNT_TOOL_NAMES } from "./account-tools.js";

export const VERSION = "0.3.0";

const INSTRUCTIONS = `StudioMeyer Academy — a free, 6-level "Memory-First AI Operator" course you can take right inside this chat.

ON CONNECT: call academy_welcome first and read it back to the user in their language (de/en/es). Then act as their tutor.

HOW TO TEACH: use academy_levels -> academy_lessons -> academy_lesson (full text). Explain lessons in your own words, answer questions, give examples — do not just paste. academy_search finds material by topic. academy_playbooks / academy_recipes are hands-on guides. Levels 1-3 are fundamentals, 4-6 cover memory, the MCP protocol, multi-agent systems and building/selling your own MCP server.

All course content is free and needs no account. (An optional ACADEMY_API_KEY unlocks personal progress, quizzes and certificates.)`;

export function createServer(mode: "public" | "full"): Server {
  const apiKey = process.env.ACADEMY_API_KEY;
  const fullMode = mode === "full" && !!apiKey;
  // Public tools are all read-only — advertise it so ChatGPT's Company-Knowledge
  // surface can call them and clients can skip confirmation prompts.
  const publicTools = PUBLIC_TOOLS.map((t) => ({ ...t, annotations: { readOnlyHint: true } }));
  const tools = fullMode ? [...publicTools, ...ACCOUNT_TOOLS] : [...publicTools];

  const server = new Server(
    { name: "mcp-academy", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (PUBLIC_TOOL_NAMES.has(name)) {
      const r = await handlePublicTool(name, args);
      if (r !== null) return r;
    }
    if (fullMode && apiKey && ACCOUNT_TOOL_NAMES.has(name)) {
      const r = await handleAccountTool(apiKey, name, args);
      if (r !== null) return r;
    }
    if (ACCOUNT_TOOL_NAMES.has(name) && !fullMode) {
      return {
        content: [{ type: "text" as const, text: `"${name}" needs an Academy account. Set ACADEMY_API_KEY (get one at https://studiomeyer.academy/dashboard/keys) and run over stdio.` }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
  });

  return server;
}
