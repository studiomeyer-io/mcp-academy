/**
 * public-tools.ts — the account-free toolset. Works with zero config, no API
 * key, no DB, no network. Ships the StudioMeyer Academy curriculum to any MCP
 * client (Claude Code/Desktop, Cursor, Codex) and — via the mandatory `search`
 * + `fetch` tools — to ChatGPT's connector/deep-research surface.
 */

import {
  type Locale,
  type ContentItem,
  bundleInfo,
  normalizeLocale,
  listLevels,
  listLessons,
  getLesson,
  listPlaybooks,
  getPlaybook,
  listRecipes,
  getRecipe,
  getById,
  search as searchBundle,
  urlFor,
} from "./content.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // Index signature so ToolResult is assignable to the SDK's CallToolResult
  // (a Zod-inferred type with `[x: string]: unknown`).
  [x: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const localeProp = {
  type: "string",
  enum: ["de", "en", "es"],
  description: "Language. de=German, en=English, es=Spanish. Default en.",
};

export const PUBLIC_TOOLS: ToolDef[] = [
  {
    name: "academy_welcome",
    description:
      "ALWAYS call this first when a user connects or asks what this is. Returns a short orientation for StudioMeyer Academy — a free 6-level 'Memory-First AI Operator' curriculum (Levels 1-3 fundamentals, 4-6 memory/MCP/multi-agent), plus playbooks and build recipes. Read it back to the user in their language and offer to start at their level.",
    inputSchema: { type: "object", properties: { locale: localeProp } },
  },
  {
    name: "academy_levels",
    description:
      "List the 6 curriculum levels with title, subtitle and lesson count. Use to show the user the learning path and ask where they want to start.",
    inputSchema: { type: "object", properties: { locale: localeProp } },
  },
  {
    name: "academy_lessons",
    description: "List all lessons in a level (titles, descriptions, duration). No body — call academy_lesson for the full text.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6, description: "Level 1-6" },
        locale: localeProp,
      },
      required: ["level"],
    },
  },
  {
    name: "academy_lesson",
    description:
      "Get the FULL text of one lesson. Teach it to the user: explain it in your own words, answer questions, give examples. This is how a user 'takes the course' with you as tutor.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6 },
        slug: { type: "string", description: 'Lesson slug, e.g. "01-was-ist-ai" (from academy_lessons)' },
        locale: localeProp,
      },
      required: ["level", "slug"],
    },
  },
  {
    name: "academy_playbooks",
    description:
      "List hands-on playbooks (short, practical how-tos for Claude Code, MCP, memory, agents). Optional category filter.",
    inputSchema: {
      type: "object",
      properties: {
        locale: localeProp,
        category: { type: "string", description: 'Optional, e.g. "build", "use"' },
      },
    },
  },
  {
    name: "academy_playbook",
    description: "Get the full text of one playbook by slug.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, locale: localeProp },
      required: ["slug"],
    },
  },
  {
    name: "academy_recipes",
    description:
      "List build recipes — step-by-step guides to build, deploy and ship real MCP servers and agent systems, organised by phase (1-16). Optional phase filter.",
    inputSchema: {
      type: "object",
      properties: { phase: { type: "number", description: "Optional phase number 1-16" } },
    },
  },
  {
    name: "academy_recipe",
    description: "Get the full text of one build recipe by slug.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "academy_search",
    description:
      "Search the whole curriculum (lessons + playbooks + recipes) by keyword. Returns ranked matches with snippets and ids. Use when the user asks about a topic and you want the most relevant material.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords" },
        locale: localeProp,
        limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "academy_tutor_context",
    description:
      "Get a lesson packaged as a tutoring brief: the full lesson text plus its learning goals and the level context. Call this when the user wants to be *taught* a lesson — then YOU act as their tutor using this material (no Academy account needed, you are the tutor).",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", minimum: 1, maximum: 6 },
        slug: { type: "string" },
        locale: localeProp,
      },
      required: ["level", "slug"],
    },
  },
  // ─── ChatGPT deep-research / connector contract: exactly `search` + `fetch` ──
  {
    name: "search",
    description:
      "Search StudioMeyer Academy course material. Returns a list of matching lessons, playbooks and recipes with ids you can pass to `fetch`.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description:
      "Fetch the full text of one Academy item (lesson, playbook or recipe) by the id returned from `search`.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Item id from search results" } },
      required: ["id"],
    },
  },
];

function text(data: unknown): ToolResult {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: body }] };
}
function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function welcomeText(locale: Locale): string {
  const info = bundleInfo();
  const intro: Record<Locale, string> = {
    de: `Willkommen bei der StudioMeyer Academy — der Memory-First AI Operator School.

Das ist ein KOSTENLOSER Kurs, direkt hier im Chat. Ich bin dein Tutor.

Was dich erwartet:
- 6 Level: 1-3 Grundlagen (LLMs, Prompting, einfache Automatisierung), 4-6 das Fortgeschrittene was sonst keiner lehrt (Memory, MCP-Protokoll, Multi-Agent-Systeme, eigenen MCP-Server bauen und verkaufen).
- Praxis-Playbooks und Build-Rezepte zum direkt Mitmachen.

So lernst du mit mir:
1. Sag mir dein Niveau, oder ich rufe academy_levels auf und wir suchen den Einstieg.
2. Ich hole die Lektion (academy_lesson) und erklaere sie dir, beantworte Fragen, gebe Beispiele.
3. Du bestimmst Tempo und Sprache (de/en/es).

Womit willst du anfangen?`,
    en: `Welcome to StudioMeyer Academy — the Memory-First AI Operator School.

This is a FREE course, right here in the chat. I'm your tutor.

What's inside:
- 6 levels: 1-3 fundamentals (LLMs, prompting, simple automation), 4-6 the advanced material almost nobody teaches (memory, the MCP protocol, multi-agent systems, building and selling your own MCP server).
- Hands-on playbooks and build recipes you can follow along.

How to learn with me:
1. Tell me your level, or I'll call academy_levels and we find your starting point.
2. I pull the lesson (academy_lesson) and teach it to you, answer questions, give examples.
3. You set the pace and language (de/en/es).

Where would you like to start?`,
    es: `Bienvenido a StudioMeyer Academy — la escuela Memory-First AI Operator.

Es un curso GRATUITO, aqui mismo en el chat. Soy tu tutor.

Que incluye:
- 6 niveles: 1-3 fundamentos (LLMs, prompting, automatizacion simple), 4-6 lo avanzado que casi nadie ensena (memoria, el protocolo MCP, sistemas multiagente, crear y vender tu propio servidor MCP).
- Playbooks practicos y recetas de construccion para seguir paso a paso.

Como aprender conmigo:
1. Dime tu nivel, o llamo a academy_levels y buscamos tu punto de partida.
2. Traigo la leccion (academy_lesson) y te la enseno, respondo preguntas, doy ejemplos.
3. Tu marcas el ritmo y el idioma (de/en/es).

Por donde quieres empezar?`,
  };
  const perLocaleLessons = Math.round(info.counts.lessons / 3);
  const perLocalePlaybooks = Math.round(info.counts.playbooks / 3);
  return `${intro[locale]}\n\n— ${perLocaleLessons} lessons · ${perLocalePlaybooks} playbooks · ${info.counts.recipes} recipes · content as of ${info.generatedAt}. Full site: https://studiomeyer.academy`;
}

/** Returns null if `name` is not a public tool (so caller can try account tools). */
export async function handlePublicTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  const locale = normalizeLocale(args.locale as string | undefined);

  switch (name) {
    case "academy_welcome":
      return text(welcomeText(locale));

    case "academy_levels":
      return text({ locale, levels: listLevels(locale) });

    case "academy_lessons": {
      const level = Number(args.level);
      if (!(level >= 1 && level <= 6)) return err("level must be 1-6");
      return text({ level, locale, lessons: listLessons(level, locale) });
    }

    case "academy_lesson": {
      const level = Number(args.level);
      const lesson = getLesson(level, String(args.slug), locale);
      if (!lesson) return err(`lesson not found: level ${level} / ${args.slug} (${locale})`);
      return text(lesson);
    }

    case "academy_playbooks":
      return text({
        locale,
        playbooks: listPlaybooks(locale, args.category ? String(args.category) : undefined),
      });

    case "academy_playbook": {
      const pb = getPlaybook(String(args.slug), locale);
      if (!pb) return err(`playbook not found: ${args.slug} (${locale})`);
      return text(pb);
    }

    case "academy_recipes": {
      let phase: number | undefined;
      if (args.phase !== undefined) {
        phase = Number(args.phase);
        if (Number.isNaN(phase) || phase < 1) return err("phase must be a positive integer (1-16), or omit for all recipes");
      }
      return text({ recipes: listRecipes(phase) });
    }

    case "academy_recipe": {
      const r = getRecipe(String(args.slug));
      if (!r) return err(`recipe not found: ${args.slug}`);
      return text(r);
    }

    case "academy_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return err("query required");
      const limit = args.limit !== undefined ? Number(args.limit) : 10;
      const hits = searchBundle(query, args.locale ? locale : undefined, limit);
      return text({ query, count: hits.length, results: hits });
    }

    case "academy_tutor_context": {
      const level = Number(args.level);
      const lesson = getLesson(level, String(args.slug), locale);
      if (!lesson) return err(`lesson not found: level ${level} / ${args.slug} (${locale})`);
      const levelInfo = listLevels(locale).find((l) => l.level === level);
      return text({
        mode: "tutor",
        instruction:
          "You are the user's tutor for this lesson. Teach it conversationally: explain the core idea, check understanding with a question or two, give a concrete example, then point to the next lesson. Do not just paste the text.",
        level,
        levelTitle: levelInfo?.title,
        lesson: { id: lesson.id, title: lesson.title, duration: lesson.duration, body: lesson.body },
        url: urlFor(lesson),
      });
    }

    // ─── ChatGPT contract ───
    case "search": {
      const query = String(args.query ?? "").trim();
      if (!query) {
        const empty = { results: [] };
        return { content: [{ type: "text", text: JSON.stringify(empty) }], structuredContent: empty };
      }
      // No locale from ChatGPT → dedupe across locales to one hit per logical item.
      const raw = searchBundle(query, undefined, 30);
      const seen = new Set<string>();
      const results: { id: string; title: string; url: string; text: string }[] = [];
      for (const h of raw) {
        const item = getById(h.id) as ContentItem | null;
        const key = item && item.type !== "recipe" ? `${item.type}:${item.slug}` : h.id;
        if (seen.has(key)) continue;
        seen.add(key);
        // `text` (snippet) is part of OpenAI's recommended search-result shape —
        // it feeds ChatGPT's result preview so it picks the right item to fetch.
        results.push({ id: h.id, title: h.title, url: h.url, text: h.snippet });
        if (results.length >= 10) break;
      }
      const payload = { results };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    }

    case "fetch": {
      const item = getById(String(args.id));
      if (!item) return err(`unknown id: ${args.id}`);
      const doc = {
        id: item.id,
        title: item.title,
        text: item.body,
        url: urlFor(item),
        metadata: {
          type: item.type,
          ...(item.type !== "recipe" ? { locale: item.locale } : {}),
          ...(item.type === "lesson" ? { level: String(item.level) } : {}),
          ...(item.type === "recipe" ? { phase: String(item.phase), tier: item.tier } : {}),
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(doc) }], structuredContent: doc };
    }

    default:
      return null;
  }
}

export const PUBLIC_TOOL_NAMES = new Set(PUBLIC_TOOLS.map((t) => t.name));
