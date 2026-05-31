/**
 * content.ts — loads the static, bundled Academy curriculum and provides the
 * read + search/fetch primitives for the PUBLIC (account-free) server mode.
 *
 * The bundle (data/academy-content.json) is produced by scripts/bundle-content.mjs
 * at our build time and shipped inside the npm package. No DB, no network, no
 * account needed to read the course.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Locale = "de" | "en" | "es";
export const LOCALES: Locale[] = ["de", "en", "es"];
export const DEFAULT_LOCALE: Locale = "en";

export interface LessonItem {
  id: string;
  type: "lesson";
  locale: Locale;
  level: number;
  slug: string;
  title: string;
  description: string | null;
  order: number;
  duration: string | null;
  tags: string[];
  paid: boolean;
  body: string;
}
export interface PlaybookItem {
  id: string;
  type: "playbook";
  locale: Locale;
  slug: string;
  category: string | null;
  title: string;
  description: string | null;
  order: number;
  duration: string | null;
  tags: string[];
  body: string;
}
export interface RecipeItem {
  id: string;
  type: "recipe";
  slug: string;
  phase: number;
  title: string;
  description: string | null;
  order: number;
  duration: string | null;
  tags: string[];
  tier: string;
  prerequisites: string[];
  body: string;
}
export type ContentItem = LessonItem | PlaybookItem | RecipeItem;

interface Bundle {
  schema: number;
  generatedAt: string;
  source: string;
  license: string;
  counts: { lessons: number; playbooks: number; recipes: number };
  lessons: LessonItem[];
  playbooks: PlaybookItem[];
  recipes: RecipeItem[];
}

function loadBundle(): Bundle {
  // dist/content.js -> ../data/academy-content.json (npm install + local build)
  // src/content.ts (tsx dev) -> ../data/academy-content.json
  const candidates = [
    new URL("../data/academy-content.json", import.meta.url),
    new URL("../../data/academy-content.json", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Bundle;
    } catch (e) {
      // Only fall through on "file not found" — a corrupt/unreadable bundle that
      // exists should surface its real error, not the misleading "not found".
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  throw new Error(
    "[mcp-academy] content bundle not found. Run `npm run bundle` (dev) or reinstall the package.",
  );
}

const BUNDLE = loadBundle();

export function bundleInfo() {
  return {
    generatedAt: BUNDLE.generatedAt,
    source: BUNDLE.source,
    counts: BUNDLE.counts,
  };
}

export function normalizeLocale(input?: string): Locale {
  const l = (input ?? "").toLowerCase().slice(0, 2);
  return (LOCALES as string[]).includes(l) ? (l as Locale) : DEFAULT_LOCALE;
}

export const ALL_ITEMS: ContentItem[] = [
  ...BUNDLE.lessons,
  ...BUNDLE.playbooks,
  ...BUNDLE.recipes,
];

const BY_ID = new Map<string, ContentItem>(ALL_ITEMS.map((i) => [i.id, i]));

// ─── Curriculum reads ───────────────────────────────────────────────────────

export interface LevelInfo {
  level: number;
  title: string;
  subtitle: string;
  paid: boolean;
  lessonCount: number;
}

// Level meta mirrors academy/src/lib/levels.ts (kept tiny + self-contained).
const LEVEL_META: Record<number, { title: string; subtitle: string; paid: boolean }> = {
  1: { title: "AI Foundations", subtitle: "What LLMs really do. Spotting hallucinations. Prompt basics.", paid: false },
  2: { title: "Productive with AI", subtitle: "Using Claude, ChatGPT, Gemini well. Context, chain-thinking.", paid: false },
  3: { title: "Simple Automation", subtitle: "Zapier, n8n, API basics. First mini-agents without code.", paid: false },
  4: { title: "Memory-First Workflow", subtitle: "MCP protocol, persistent memory, hooks, skills. Portable across Claude, Cursor, Codex.", paid: true },
  5: { title: "Multi-Agent Systems", subtitle: "CEO/Worker pattern, Critic, Research, Analyst. Cross-agent memory.", paid: true },
  6: { title: "Full-Stack AI Systems", subtitle: "Build, deploy and sell your own MCP server. SaaS architecture.", paid: true },
};

export function listLevels(locale: Locale): LevelInfo[] {
  return [1, 2, 3, 4, 5, 6].map((level) => {
    const meta = LEVEL_META[level];
    const lessonCount = BUNDLE.lessons.filter(
      (l) => l.level === level && l.locale === locale,
    ).length;
    return { level, title: meta.title, subtitle: meta.subtitle, paid: meta.paid, lessonCount };
  });
}

export function listLessons(level: number, locale: Locale) {
  return BUNDLE.lessons
    .filter((l) => l.level === level && l.locale === locale)
    .sort((a, b) => a.order - b.order)
    .map(({ body, ...meta }) => meta);
}

export function getLesson(level: number, slug: string, locale: Locale): LessonItem | null {
  return (
    BUNDLE.lessons.find((l) => l.level === level && l.slug === slug && l.locale === locale) ?? null
  );
}

export function listPlaybooks(locale: Locale, category?: string) {
  return BUNDLE.playbooks
    .filter((p) => p.locale === locale && (!category || p.category === category))
    .sort((a, b) => a.order - b.order)
    .map(({ body, ...meta }) => meta);
}

export function getPlaybook(slug: string, locale: Locale): PlaybookItem | null {
  return BUNDLE.playbooks.find((p) => p.slug === slug && p.locale === locale) ?? null;
}

export function listRecipes(phase?: number) {
  return BUNDLE.recipes
    .filter((r) => phase === undefined || r.phase === phase)
    .sort((a, b) => a.phase - b.phase || a.order - b.order)
    .map(({ body, ...meta }) => meta);
}

export function getRecipe(slug: string): RecipeItem | null {
  return BUNDLE.recipes.find((r) => r.slug === slug) ?? null;
}

export function getById(id: string): ContentItem | null {
  return BY_ID.get(id) ?? null;
}

// ─── Search (powers ChatGPT `search` + the academy_search tool) ──────────────

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  type: ContentItem["type"];
  snippet: string;
  score: number;
}

const PUBLIC_BASE = "https://studiomeyer.academy";

export function urlFor(item: ContentItem): string {
  switch (item.type) {
    case "lesson":
      return `${PUBLIC_BASE}/${item.locale}/levels/${item.level}/${item.slug}`;
    case "playbook":
      return `${PUBLIC_BASE}/${item.locale}/playbooks/${item.slug}`;
    case "recipe":
      return `${PUBLIC_BASE}/dashboard/recipes/${item.slug}`;
  }
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function snippet(body: string, terms: string[], len = 240): string {
  const lower = body.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = lower.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  const start = pos === -1 ? 0 : Math.max(0, pos - 60);
  const raw = body.slice(start, start + len).replace(/\s+/g, " ").trim();
  return (start > 0 ? "..." : "") + raw + (start + len < body.length ? "..." : "");
}

/**
 * Lexical relevance scan over the bundle. locale filters lessons/playbooks
 * (recipes are locale-agnostic and always considered). Field weights: title >
 * description/tags > body. Multi-term queries reward items matching more terms.
 */
export function search(query: string, locale?: Locale, limit = 10): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const loc = locale ? normalizeLocale(locale) : undefined;

  const scored: SearchHit[] = [];
  for (const item of ALL_ITEMS) {
    if (item.type !== "recipe" && loc && item.locale !== loc) continue;

    const title = item.title.toLowerCase();
    const desc = (item.description ?? "").toLowerCase();
    const tags = item.tags.join(" ").toLowerCase();
    const body = item.body.toLowerCase();

    let score = 0;
    let matchedTerms = 0;
    for (const t of terms) {
      let termHit = false;
      if (title.includes(t)) { score += 10; termHit = true; }
      if (desc.includes(t)) { score += 4; termHit = true; }
      if (tags.includes(t)) { score += 3; termHit = true; }
      if (body.includes(t)) { score += 1; termHit = true; }
      if (termHit) matchedTerms++;
    }
    if (matchedTerms === 0) continue;
    // reward coverage: all terms matched beats one of many
    score *= 1 + matchedTerms / terms.length;
    // exact phrase bonus
    const ql = query.toLowerCase();
    if (title.includes(ql)) score += 15;
    else if (body.includes(ql)) score += 5;

    scored.push({
      id: item.id,
      title: item.title,
      url: urlFor(item),
      type: item.type,
      snippet: snippet(item.body, terms),
      score: Math.round(score * 100) / 100,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(50, limit)));
}
