/**
 * server.ts — builds a configured MCP Server instance.
 *
 * Two modes:
 *   - "public": account-free. Curriculum reads + search/fetch from the bundle.
 *               Zero config. This is `npx mcp-academy` without a key — the
 *               library. NOT the hosted endpoint: that one authenticates every
 *               request and always builds a signed-in server (see http.ts).
 *   - "full":   public tools PLUS account tools (progress/quiz/certs/tutor) bound
 *               to a personal ACADEMY_API_KEY. stdio only.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PUBLIC_TOOLS, handlePublicTool, PUBLIC_TOOL_NAMES } from "./public-tools.js";
import { ACCOUNT_TOOLS, handleAccountTool, ACCOUNT_TOOL_NAMES, type BridgeAuth } from "./account-tools.js";

// Must match package.json — smoke-test.mjs fails the build if it drifts.
export const VERSION = "0.4.0";

const INSTRUCTIONS = `StudioMeyer Academy — a free, 6-level "Memory-First AI Operator" course you can take right inside this chat.

ON CONNECT: call academy_welcome first and read it back to the user in their language (de/en/es). Then act as their tutor.

HOW TO TEACH: use academy_levels -> academy_lessons -> academy_lesson (full text). Explain lessons in your own words, answer questions, give examples — do not just paste. academy_search finds material by topic. academy_playbooks / academy_recipes are hands-on guides. Levels 1-3 are fundamentals, 4-6 cover memory, the MCP protocol, multi-agent systems and building/selling your own MCP server.

All course content is free and needs no account. (An optional ACADEMY_API_KEY unlocks personal progress, quizzes and certificates.)`;

/** What the signed-in course adds on top of the reading instructions. */
const SIGNED_IN_ADDENDUM = `

THIS PERSON IS SIGNED IN. Alongside the lessons you also have their progress: academy_stats (XP, streak, where they stand), academy_next_lesson (what to do next — a good opener), academy_progress_complete when they finish one, academy_quiz + academy_quiz_submit to check understanding, academy_review for what is due again, academy_certificates, and academy_tutor for a question you cannot answer from the material.

Use them like a tutor who remembers, not like a form: open by looking up where they left off, mark a lesson complete when they are actually done with it rather than asking them to confirm bookkeeping, and offer the quiz instead of demanding it.`;

function instructionsFor(mode: ServerMode): string {
  return typeof mode === "object" ? INSTRUCTIONS + SIGNED_IN_ADDENDUM : INSTRUCTIONS;
}

/**
 * How this instance is being used:
 *
 *   "public"  the library. Curriculum reads from the bundle, nobody signed in.
 *             `npx mcp-academy` with no key.
 *   "full"    stdio with a personal ACADEMY_API_KEY (legacy).
 *   an email  the hosted course, one signed-in person, one request.
 *
 * The hosted server builds a fresh instance per request, so the email never
 * outlives the request that proved it.
 */
export type ServerMode = "public" | "full" | { courseFor: string };

export function createServer(mode: ServerMode): Server {
  const apiKey = process.env.ACADEMY_API_KEY;
  const auth: BridgeAuth | null =
    typeof mode === "object"
      ? { kind: "oauth", email: mode.courseFor }
      : mode === "full" && apiKey
        ? { kind: "api_key", apiKey }
        : null;
  // Public tools are all read-only — advertise it so ChatGPT's Company-Knowledge
  // surface can call them and clients can skip confirmation prompts.
  const publicTools = PUBLIC_TOOLS.map((t) => ({ ...t, annotations: { readOnlyHint: true } }));
  const tools = auth ? [...publicTools, ...ACCOUNT_TOOLS] : [...publicTools];

  const server = new Server(
    { name: "mcp-academy", version: VERSION },
    { capabilities: { tools: {} }, instructions: instructionsFor(mode) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (PUBLIC_TOOL_NAMES.has(name)) {
      const r = await handlePublicTool(name, args);
      if (r !== null) return r;
    }
    if (auth && ACCOUNT_TOOL_NAMES.has(name)) {
      const r = await handleAccountTool(auth, name, args);
      if (r !== null) return r;
    }
    if (ACCOUNT_TOOL_NAMES.has(name) && !auth) {
      return {
        content: [{
          type: "text" as const,
          text: `"${name}" keeps track of you, so it needs an account. This is the offline library — connect the hosted course at https://mcp.studiomeyer.academy/mcp and sign in once (Google, Discord or a link by email). Everything you can read here stays free either way.`,
        }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
  });

  return server;
}
