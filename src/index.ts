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
const VERSION = "0.1.0";

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
  { capabilities: { tools: {} } },
);

// ─── Tool Definitions ────────────────────────────────

const TOOLS = [
  {
    name: "academy_stats",
    description:
      "Get your Academy stats: XP, rank, streak, lessons completed, badges, certificates, current weekly league. Call this first to see where you stand.",
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
