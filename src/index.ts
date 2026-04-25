#!/usr/bin/env node
/**
 * mcp-academy — MCP server for StudioMeyer Academy
 *
 * Connects Claude Code / Cursor / Claude Desktop to your Academy account.
 * Pulls your real progress, recommends next lesson, submits quizzes,
 * reviews flashcards, talks to the AI-Tutor — all inside your chat.
 *
 * Auth: Bearer API-Key, created in https://academy.studiomeyer.io/dashboard/keys
 *
 * Env vars:
 *   ACADEMY_API_KEY         — required. Format "academy_<...>".
 *   ACADEMY_BASE_URL        — optional. Default "https://academy.studiomeyer.io".
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.ACADEMY_API_KEY;
const BASE_URL = (process.env.ACADEMY_BASE_URL ?? "https://academy.studiomeyer.io").replace(/\/$/, "");
const VERSION = "0.2.1";

// ============================================================
// INSTRUCTIONS — Always-On Academy Switch (Memory v3.16 pattern)
// ============================================================
//
// Static block — Academy is multi-user via API-Key per process so
// per-tenant probes from the npm-side don't make sense. The Tool-
// Response Forcing-Channel in academy_stats handles the per-user
// onboarding signal: when the user has xp=0 + 0 lessons completed,
// the response carries isFirstTimeUser:true + onboardingHint.
//
// SIZE CONSTRAINT (Memory v3.16 lesson): keep under 1900 chars.
const INSTRUCTIONS = `StudioMeyer Academy — Memory-First AI Operator School (23 tools).

EVERY SESSION: Call academy_stats first to see XP, rank, streak, current league.
HELP: Call academy_levels to see all 6 levels + access status. academy_next_lesson recommends what to do next.
RECIPES: Phase B (2026-04-25) added 51 step-by-step Recipes (instant howtos) + 44 Concepts (mini knowledge graph). Use academy_list_recipes / academy_concept_search.

TOOL-SYNTAX STAYS INTERNAL: never quote function-call syntax to the user. Invoke tools silently and tell them in plain language what happened ("You're at 1240 XP, rank Apprentice", "Next up: Memory Patterns lesson", "Quiz scored 8/10").

AUTO-LOAD OFFER (mention once, not every session):
Academy loads only when the model calls a tool. Two ways to automate:
1. Hook setup (Claude Code): the model can write a SessionStart hook to
   ~/.claude/settings.json. Offer once; if the user agrees, edit the file
   directly — never paste config to chat. Cursor / Codex / claude.ai use
   other mechanisms — point at https://aiguide.studiomeyer.io.
2. Trigger phrase (zero setup): user says "load academy" at session start
   — model then calls academy_stats + academy_next_lesson.`;

if (!API_KEY) {
  process.stderr.write(
    "[mcp-academy] ACADEMY_API_KEY is missing. Create one at https://academy.studiomeyer.io/dashboard/keys and set ACADEMY_API_KEY.\n",
  );
  process.exit(1);
}

async function call(method: "GET" | "POST", tool: string, body?: unknown, qs?: Record<string, string | number | undefined>) {
  const url = new URL(`/api/mcp/${tool}`, BASE_URL);
  if (qs) {
    for (const [k, v] of Object.entries(qs)) if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "user-agent": `mcp-academy/${VERSION}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = (data as { error?: string })?.error ?? `http_${res.status}`;
    throw new Error(`${tool} failed: ${err}`);
  }
  return data;
}

const server = new Server(
  { name: "mcp-academy", version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

// ─── Tool Definitions ────────────────────────────────

const TOOLS = [
  {
    name: "academy_stats",
    description:
      "Get your Academy stats: XP, rank, streak, lessons completed, badges, certificates, current weekly league. Call this FIRST every session to see where you stand. ⚠ If response includes isFirstTimeUser:true or onboardingHint, you MUST follow the directive before responding to the user — they are a brand-new Academy user and need onboarding plus hook-setup explained proactively.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_levels",
    description:
      "List all 6 levels with access info (free / paid / earned). Shows which levels you can access right now and your earn-access progress.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_lessons",
    description: "List all lessons within a level, with completed status.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6, description: "Level number 1-6" },
        locale: { type: "string", enum: ["de", "en", "es"], default: "de" },
      },
      required: ["level"],
    },
  },
  {
    name: "academy_lesson",
    description: "Get full content of a specific lesson.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6 },
        slug: { type: "string", description: 'Lesson slug, e.g. "01-was-ist-ai"' },
        locale: { type: "string", enum: ["de", "en", "es"], default: "de" },
      },
      required: ["level", "slug"],
    },
  },
  {
    name: "academy_next_lesson",
    description:
      "Recommend the next lesson based on your progress. Returns the first incomplete lesson in the lowest level you have access to.",
    inputSchema: {
      type: "object",
      properties: { locale: { type: "string", enum: ["de", "en", "es"], default: "de" } },
    },
  },
  {
    name: "academy_progress_complete",
    description:
      "Mark a lesson as completed. Grants XP, updates streak, schedules spaced-repetition review. Only works for levels you have access to.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6 },
        slug: { type: "string" },
        locale: { type: "string", enum: ["de", "en", "es"], default: "de" },
      },
      required: ["level", "slug"],
    },
  },
  {
    name: "academy_quiz",
    description:
      "Fetch a quiz (lesson quiz or end-of-level checkpoint). Provide either slug, OR level+lessonSlug (for lesson quiz), OR just level (for checkpoint).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Direct quiz slug if known" },
        level: { type: "number", minimum: 1, maximum: 6 },
        lessonSlug: { type: "string" },
        locale: { type: "string", enum: ["de", "en", "es"], default: "de" },
      },
    },
  },
  {
    name: "academy_quiz_submit",
    description:
      "Submit answers to a quiz. Returns score, whether you passed, XP awarded, per-question correctness + explanations. If checkpoint and passed → certificate issued.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Quiz slug" },
        answers: {
          type: "object",
          description: 'Answers keyed by questionId, e.g. {"q1":"b","q2":"a"}',
          additionalProperties: { type: "string" },
        },
      },
      required: ["slug", "answers"],
    },
  },
  {
    name: "academy_review",
    description: "List spaced-repetition items due for review today.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_review_grade",
    description:
      "Grade a review item after recall attempt. grade=again resets to 1d, good/easy grows the interval via SM-2.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Review item ID" },
        grade: { type: "string", enum: ["again", "good", "easy"] },
      },
      required: ["id", "grade"],
    },
  },
  {
    name: "academy_certificates",
    description: "List your earned certificates with public verification URLs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_tutor",
    description:
      "Ask the Academy AI-Tutor a question. Pro-only. The tutor knows the current lesson context if you provide level+lessonSlug.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", maxLength: 2000 },
        level: { type: "number", minimum: 1, maximum: 6 },
        lessonSlug: { type: "string" },
      },
      required: ["message", "level"],
    },
  },
  // ─── Recipes (Phase B, mcp-academy v0.2.0) ────────────────────
  {
    name: "academy_list_recipes",
    description:
      "List all 74 setup recipes (15 phases × 5 recipes, except phase 1 with 4). Phase 1-5 free, 6-10 Pro EUR 19/Mo or single-buy, 11-15 coming soon. Returns slug, phase, order, title, duration, tier, status (completed/in_progress/not_started/locked/coming_soon), accessReason.",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "number", minimum: 1, maximum: 15 },
        tier: { type: "string", enum: ["free", "pro", "team"] },
        include_locked: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "academy_get_recipe",
    description:
      "Get the full recipe by slug — body + steps + per-step clientCheck snippets the LLM should run. If locked, returns teaser + upgrade hint.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "e.g. \"1.1-claude-md\"" } },
      required: ["slug"],
    },
  },
  {
    name: "academy_start_recipe",
    description:
      "Start (or restart with { restart: true }) a recipe. Marks the user's RecipeProgress, returns first step + clientCheck. One active recipe at a time per user.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        restart: { type: "boolean", default: false },
      },
      required: ["slug"],
    },
  },
  {
    name: "academy_next_step",
    description:
      "Get the user's current step on the active recipe — body + clientCheck if a validator is bound. No active recipe → null.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_validate_step",
    description:
      "Validate the current step. SaaS server cannot stat user FS, so the response is one of: \"client_check_required\" (LLM runs the command from clientCheck, then calls again with manual:true), \"manual\" (advanced, manual:true), \"no_validator\" (step has no check, advance with manual:true), or recipeCompleted:true if last step.",
    inputSchema: {
      type: "object",
      properties: { manual: { type: "boolean", default: false } },
    },
  },
  {
    name: "academy_my_recipes",
    description:
      "Recipe progress overview — active recipe, completed count per phase, accessible-but-not-started count, next recommended recipe.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_save_recipe_note",
    description:
      "Save a personal note attached to a recipe (and optionally a step). Returns the noteId. Notes survive recipe restarts.",
    inputSchema: {
      type: "object",
      properties: {
        recipeSlug: { type: "string" },
        content: { type: "string", maxLength: 4000 },
        step: { type: "number" },
      },
      required: ["recipeSlug", "content"],
    },
  },
  // ─── Knowledge Graph (Phase B) ────────────────────────────────
  {
    name: "academy_concept_search",
    description:
      "Search 32 concepts (config files, features, MCP servers, OAuth/SaaS patterns, operator patterns) by query string. Trigram + fallback ILIKE. Pro/Team concepts return summary only for free users.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["q"],
    },
  },
  {
    name: "academy_concept_open",
    description:
      "Get a single concept + its outgoing/incoming relations + recent observations. Pro/Team concepts return body only for paid users.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "academy_concept_graph",
    description:
      "N-hop neighborhood graph for a concept. depth=2 default (1-3 allowed). Returns nodes + edges so the LLM can reason about related concepts.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        depth: { type: "number", minimum: 1, maximum: 3, default: 2 },
      },
      required: ["slug"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "academy_stats":
        return toText(await call("GET", "stats"));
      case "academy_levels":
        return toText(await call("GET", "levels"));
      case "academy_lessons":
        return toText(await call("GET", "lessons", undefined, {
          level: Number(args.level),
          locale: (args.locale as string) ?? "de",
        }));
      case "academy_lesson":
        return toText(await call("GET", "lesson", undefined, {
          level: Number(args.level),
          slug: String(args.slug),
          locale: (args.locale as string) ?? "de",
        }));
      case "academy_next_lesson":
        return toText(await call("GET", "next-lesson", undefined, {
          locale: (args.locale as string) ?? "de",
        }));
      case "academy_progress_complete":
        return toText(await call("POST", "progress-complete", {
          level: Number(args.level),
          lessonSlug: String(args.slug),
          locale: (args.locale as string) ?? "de",
        }));
      case "academy_quiz":
        return toText(await call("GET", "quiz", undefined, {
          slug: args.slug ? String(args.slug) : undefined,
          level: args.level ? Number(args.level) : undefined,
          lessonSlug: args.lessonSlug ? String(args.lessonSlug) : undefined,
          locale: (args.locale as string) ?? "de",
        }));
      case "academy_quiz_submit":
        return toText(await call("POST", "quiz-submit", {
          slug: String(args.slug),
          answers: args.answers ?? {},
        }));
      case "academy_review":
        return toText(await call("GET", "review"));
      case "academy_review_grade":
        return toText(await call("POST", "review-grade", {
          id: String(args.id),
          grade: String(args.grade),
        }));
      case "academy_certificates":
        return toText(await call("GET", "certificates"));
      case "academy_tutor":
        return toText(await call("POST", "tutor", {
          message: String(args.message),
          level: Number(args.level),
          lessonSlug: args.lessonSlug ? String(args.lessonSlug) : undefined,
        }));
      // Recipes (Phase B)
      case "academy_list_recipes":
        return toText(await call("GET", "list-recipes", undefined, {
          phase: args.phase ? Number(args.phase) : undefined,
          tier: args.tier ? String(args.tier) : undefined,
          include_locked: args.include_locked === false ? "false" : undefined,
        }));
      case "academy_get_recipe":
        return toText(await call("GET", "get-recipe", undefined, { slug: String(args.slug) }));
      case "academy_start_recipe":
        return toText(await call("POST", "start-recipe", {
          slug: String(args.slug),
          restart: !!args.restart,
        }));
      case "academy_next_step":
        return toText(await call("GET", "next-step"));
      case "academy_validate_step":
        return toText(await call("POST", "validate-step", { manual: !!args.manual }));
      case "academy_my_recipes":
        return toText(await call("GET", "my-recipes"));
      case "academy_save_recipe_note":
        return toText(await call("POST", "save-recipe-note", {
          recipeSlug: String(args.recipeSlug),
          content: String(args.content),
          step: args.step != null ? Number(args.step) : undefined,
        }));
      case "academy_concept_search":
        return toText(await call("GET", "concept-search", undefined, {
          q: String(args.q),
          limit: args.limit ? Number(args.limit) : undefined,
        }));
      case "academy_concept_open":
        return toText(await call("GET", "concept-open", undefined, { slug: String(args.slug) }));
      case "academy_concept_graph":
        return toText(await call("GET", "concept-graph", undefined, {
          slug: String(args.slug),
          depth: args.depth ? Number(args.depth) : undefined,
        }));
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

function toText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mcp-academy v${VERSION}] connected to ${BASE_URL}\n`);
