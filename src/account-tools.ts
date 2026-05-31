/**
 * account-tools.ts — the OPTIONAL, account-bound toolset. Only registered when
 * ACADEMY_API_KEY is set. These talk to the private Academy REST bridge
 * (/api/mcp/*) with a Bearer token and touch the DB: progress, quizzes,
 * spaced-repetition, certificates, the Pro AI-tutor.
 *
 * Content reads (levels/lessons/playbooks/recipes/search) are NOT here — the
 * public bundle covers those offline, which is faster and needs no key.
 */

import type { ToolDef, ToolResult } from "./public-tools.js";

const DEFAULT_BASE = "https://studiomeyer.academy";

function baseUrl(): string {
  return (process.env.ACADEMY_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

async function call(
  apiKey: string,
  method: "GET" | "POST",
  tool: string,
  body?: unknown,
  qs?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const url = new URL(`/api/mcp/${tool}`, baseUrl());
  if (qs) for (const [k, v] of Object.entries(qs)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": "mcp-academy",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data: unknown;
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!res.ok) {
    const e = (data as { error?: string })?.error ?? `http_${res.status}`;
    throw new Error(`${tool} failed: ${e}`);
  }
  return data;
}

export const ACCOUNT_TOOLS: ToolDef[] = [
  {
    name: "academy_stats",
    description: "Your Academy account stats: XP, rank, streak, lessons completed, badges, certificates, weekly league. (Requires API key.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_next_lesson",
    description: "Recommend your next lesson based on real progress (first incomplete lesson in the lowest level you can access). (Requires API key.)",
    inputSchema: { type: "object", properties: { locale: { type: "string", enum: ["de", "en", "es"] } } },
  },
  {
    name: "academy_progress_complete",
    description: "Mark a lesson complete: grants XP, updates streak, schedules spaced-repetition. (Requires API key.)",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6 },
        slug: { type: "string" },
        locale: { type: "string", enum: ["de", "en", "es"] },
      },
      required: ["level", "slug"],
    },
  },
  {
    name: "academy_quiz",
    description: "Fetch a quiz (lesson quiz or end-of-level checkpoint). (Requires API key.)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        level: { type: "number", minimum: 1, maximum: 6 },
        lessonSlug: { type: "string" },
        locale: { type: "string", enum: ["de", "en", "es"] },
      },
    },
  },
  {
    name: "academy_quiz_submit",
    description: "Submit quiz answers → score, pass/fail, XP, per-question correctness + explanations. Passing a checkpoint issues a certificate. (Requires API key.)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        answers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["slug", "answers"],
    },
  },
  {
    name: "academy_review",
    description: "List spaced-repetition items due today. (Requires API key.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_review_grade",
    description: "Grade a review item (again/good/easy) — SM-2 interval update. (Requires API key.)",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, grade: { type: "string", enum: ["again", "good", "easy"] } },
      required: ["id", "grade"],
    },
  },
  {
    name: "academy_certificates",
    description: "List your earned certificates with public verification URLs. (Requires API key.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_tutor",
    description: "Ask the Academy Pro AI-Tutor (server-side, knows the lesson context). Pro plan only. For free self-tutoring use academy_tutor_context instead. (Requires API key.)",
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

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));

function toText(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

/** Returns null if `name` is not an account tool. */
export async function handleAccountTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  try {
    switch (name) {
      case "academy_stats":
        return toText(await call(apiKey, "GET", "stats"));
      case "academy_next_lesson":
        return toText(await call(apiKey, "GET", "next-lesson", undefined, { locale: (args.locale as string) ?? "en" }));
      case "academy_progress_complete":
        return toText(await call(apiKey, "POST", "progress-complete", {
          level: Number(args.level),
          lessonSlug: String(args.slug),
          locale: (args.locale as string) ?? "en",
        }));
      case "academy_quiz":
        return toText(await call(apiKey, "GET", "quiz", undefined, {
          slug: args.slug ? String(args.slug) : undefined,
          level: args.level ? Number(args.level) : undefined,
          lessonSlug: args.lessonSlug ? String(args.lessonSlug) : undefined,
          locale: (args.locale as string) ?? "en",
        }));
      case "academy_quiz_submit":
        return toText(await call(apiKey, "POST", "quiz-submit", { slug: String(args.slug), answers: args.answers ?? {} }));
      case "academy_review":
        return toText(await call(apiKey, "GET", "review"));
      case "academy_review_grade":
        return toText(await call(apiKey, "POST", "review-grade", { id: String(args.id), grade: String(args.grade) }));
      case "academy_certificates":
        return toText(await call(apiKey, "GET", "certificates"));
      case "academy_tutor":
        return toText(await call(apiKey, "POST", "tutor", {
          message: String(args.message),
          level: Number(args.level),
          lessonSlug: args.lessonSlug ? String(args.lessonSlug) : undefined,
        }));
      default:
        return null;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
