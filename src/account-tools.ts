/**
 * account-tools.ts — the account-bound toolset: progress, quizzes,
 * spaced-repetition, certificates, the AI tutor. Everything that needs to know
 * WHO is asking. Content reads are not here; the bundle covers those offline.
 *
 * Two ways to prove who is asking, and they are not equal:
 *
 *   stdio + ACADEMY_API_KEY   the legacy path. The person pasted a personal
 *                             key into their config. Nobody did — zero keys
 *                             were ever issued — but it still works, so it stays.
 *
 *   hosted + OAuth            the real one. The person signed in with Google,
 *                             Discord or an emailed link, and this server holds
 *                             a verified email for the duration of the request.
 *
 * The OAuth path calls the bridge as a SERVICE: our own token in the
 * Authorization header, the user's email in `x-academy-user`. That header is
 * an authority claim, so two rules are absolute — this server sets it itself
 * and never forwards one from an incoming request, and the Academy only
 * honours it when the service token checks out. Anything else would let a
 * caller name any account they like.
 */

import type { ToolDef, ToolResult } from "./public-tools.js";

/** Who this call is made on behalf of, and how we prove it. */
export type BridgeAuth =
  | { kind: "api_key"; apiKey: string }
  | { kind: "oauth"; email: string };

const DEFAULT_BASE = "https://studiomeyer.academy";

function baseUrl(): string {
  return (process.env.ACADEMY_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

function authHeaders(auth: BridgeAuth): Record<string, string> {
  if (auth.kind === "api_key") {
    return { authorization: `Bearer ${auth.apiKey}` };
  }
  const serviceToken = process.env.ACADEMY_MCP_SERVICE_TOKEN;
  if (!serviceToken) {
    // Fail loudly. Without the token the bridge would answer 401 and the user
    // would see "stats failed: unauthorized" — a deployment mistake wearing the
    // costume of an auth problem.
    throw new Error(
      "ACADEMY_MCP_SERVICE_TOKEN is not set — the hosted course server cannot reach the Academy bridge.",
    );
  }
  return {
    authorization: `Bearer ${serviceToken}`,
    "x-academy-user": auth.email,
  };
}

async function call(
  auth: BridgeAuth,
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
      ...authHeaders(auth),
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
    description: "Your Academy account stats: XP, rank, streak, lessons completed, badges, certificates, weekly league. (Requires sign-in.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_next_lesson",
    description: "Recommend your next lesson based on real progress (first incomplete lesson in the lowest level you can access). (Requires sign-in.)",
    inputSchema: { type: "object", properties: { locale: { type: "string", enum: ["de", "en", "es"] } } },
  },
  {
    name: "academy_progress_complete",
    description: "Mark a lesson complete: grants XP, updates streak, schedules spaced-repetition. (Requires sign-in.)",
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
    description: "Fetch a quiz (lesson quiz or end-of-level checkpoint). (Requires sign-in.)",
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
    description: "Submit quiz answers → score, pass/fail, XP, per-question correctness + explanations. Passing a checkpoint issues a certificate. (Requires sign-in.)",
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
    description: "List spaced-repetition items due today. (Requires sign-in.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_review_grade",
    description: "Grade a review item (again/good/easy) — SM-2 interval update. (Requires sign-in.)",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, grade: { type: "string", enum: ["again", "good", "easy"] } },
      required: ["id", "grade"],
    },
  },
  {
    name: "academy_certificates",
    description: "List your earned certificates with public verification URLs. (Requires sign-in.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "academy_tutor",
    description: "Ask the Academy Pro AI-Tutor (server-side, knows the lesson context). Pro plan only. For free self-tutoring use academy_tutor_context instead. (Requires sign-in.)",
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
  auth: BridgeAuth,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  try {
    switch (name) {
      case "academy_stats":
        return toText(await call(auth, "GET", "stats"));
      case "academy_next_lesson":
        return toText(await call(auth, "GET", "next-lesson", undefined, { locale: (args.locale as string) ?? "en" }));
      case "academy_progress_complete":
        return toText(await call(auth, "POST", "progress-complete", {
          level: Number(args.level),
          lessonSlug: String(args.slug),
          locale: (args.locale as string) ?? "en",
        }));
      case "academy_quiz":
        return toText(await call(auth, "GET", "quiz", undefined, {
          slug: args.slug ? String(args.slug) : undefined,
          level: args.level ? Number(args.level) : undefined,
          lessonSlug: args.lessonSlug ? String(args.lessonSlug) : undefined,
          locale: (args.locale as string) ?? "en",
        }));
      case "academy_quiz_submit":
        return toText(await call(auth, "POST", "quiz-submit", { slug: String(args.slug), answers: args.answers ?? {} }));
      case "academy_review":
        return toText(await call(auth, "GET", "review"));
      case "academy_review_grade":
        return toText(await call(auth, "POST", "review-grade", { id: String(args.id), grade: String(args.grade) }));
      case "academy_certificates":
        return toText(await call(auth, "GET", "certificates"));
      case "academy_tutor":
        return toText(await call(auth, "POST", "tutor", {
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
