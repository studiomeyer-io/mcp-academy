#!/usr/bin/env node
/**
 * bundle-content.mjs — bakes the public StudioMeyer Academy course content
 * into a single static JSON file that ships inside the npm package.
 *
 * WHY: the public mcp-academy server is offline-first and account-free. It must
 * carry the curriculum with it (npm install / hosted HTTP), so end-users never
 * need our DB, an account, or network access to read the course.
 *
 * SOURCE  : ACADEMY_REPO/content/(de|en|es)/level-N/(file).mdx
 *           ACADEMY_REPO/content/(de|en|es)/playbooks/(file).mdx
 *           ACADEMY_REPO/content/recipes/phase-N/(file).mdx   (locale-agnostic, EN)
 * TARGET  : THIS_REPO/data/academy-content.json
 *
 * HARD RULES (this is a PUBLIC, open-source bundle — condition: no leaks):
 *   1. WHITELIST ONLY. We read exactly the three content roots above. Nothing
 *      else from the academy repo can ever end up in the bundle.
 *   2. LEAK GATE. Every body + frontmatter value is scanned for real secrets.
 *      A real-looking secret aborts the build (exit 1). Teaching placeholders
 *      (xxx, <key>, secrets.X, your-..., example) are allowed.
 *   3. body_pending lessons (translated frontmatter, untranslated body) are
 *      skipped per-locale so we never ship half-translated text as finished.
 *
 * Run:  ACADEMY_CONTENT_DIR=/home/simple/academy/content node scripts/bundle-content.mjs
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR =
  process.env.ACADEMY_CONTENT_DIR || join(REPO_ROOT, "..", "academy", "content");
const OUT_FILE = join(REPO_ROOT, "data", "academy-content.json");

const LOCALES = ["de", "en", "es"];
const LEVELS = [1, 2, 3, 4, 5, 6];

// ─── Leak gate ──────────────────────────────────────────────────────────────
// Patterns that match REAL secrets. Each match is run past isPlaceholder() so
// the curriculum's teaching examples don't trip the gate.
const SECRET_PATTERNS = [
  { name: "anthropic-api-key", re: /sk-ant-(?:api|oat|sid)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "stripe-secret", re: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { name: "stripe-webhook", re: /whsec_[A-Za-z0-9]{20,}/g },
  { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "resend-key", re: /re_[A-Za-z0-9]{20,}/g },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "github-pat", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "academy-key", re: /academy_[A-Za-z0-9]{24,}/g },
  { name: "postgres-url", re: /postgres(?:ql)?:\/\/[^\s:'"`]+:[^\s@'"`]+@[^\s/'"`]+/g },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];

// Markers that mark a *match* as a teaching placeholder. Kept to tokens that only
// ever appear in fake examples — NOT substrings that could sit inside a real key
// (removed: "env.", "secrets.", "abc123", "0000" — those gave false-negatives).
const PLACEHOLDER_MARKERS = [
  "xxx", "...", "<", ">", "your-", "your_", "dein", "deine",
  "example", "placeholder", "redacted", "changeme", "yyyy", "zzzz", "fake", "dummy",
];

function isPlaceholder(match) {
  const m = match.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((p) => m.includes(p))) return true;
  if (/(.)\1{5,}/.test(m)) return true; // 6+ repeated chars (xxxxxx, aaaaaa)
  return false;
}

const leaks = [];
function scanForLeaks(where, text) {
  if (!text || typeof text !== "string") return;
  for (const { name, re } of SECRET_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const hit = match[0];
      if (isPlaceholder(hit)) continue;
      leaks.push({ where, pattern: name, sample: hit.slice(0, 24) + "..." });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
async function listMdx(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(".mdx")).sort();
}

function clean(meta) {
  return {
    title: meta.title ?? null,
    description: meta.description ?? null,
    order: Number(meta.order ?? 0),
    duration: meta.duration ?? null,
    tags: Array.isArray(meta.tags)
      ? meta.tags
      : typeof meta.tags === "string"
        ? meta.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [],
  };
}

// ─── Build ────────────────────────────────────────────────────────────────
async function build() {
  if (!existsSync(CONTENT_DIR)) {
    console.error(`[bundle] content dir not found: ${CONTENT_DIR}`);
    console.error(`[bundle] set ACADEMY_CONTENT_DIR=/path/to/academy/content`);
    process.exit(1);
  }
  console.error(`[bundle] reading from ${CONTENT_DIR}`);

  const out = { lessons: [], playbooks: [], recipes: [] };
  let skippedPending = 0;

  for (const locale of LOCALES) {
    for (const level of LEVELS) {
      const dir = join(CONTENT_DIR, locale, `level-${level}`);
      for (const file of await listMdx(dir)) {
        const raw = await readFile(join(dir, file), "utf8");
        const { data, content } = matter(raw);
        const slug = file.replace(/\.mdx$/, "");
        if (data.body_pending) { skippedPending++; continue; }
        const where = `${locale}/level-${level}/${slug}`;
        scanForLeaks(where, content);
        scanForLeaks(where + "#fm", JSON.stringify(data));
        out.lessons.push({
          id: `lesson:${locale}:${level}:${slug}`,
          type: "lesson",
          locale, level, slug,
          ...clean(data),
          paid: Boolean(data.paid) || level >= 4, // L4-6 are the deep tiers (levels.ts)
          body: content.trim(),
        });
      }
    }

    const pbDir = join(CONTENT_DIR, locale, "playbooks");
    for (const file of await listMdx(pbDir)) {
      const raw = await readFile(join(pbDir, file), "utf8");
      const { data, content } = matter(raw);
      const slug = file.replace(/\.mdx$/, "");
      if (data.body_pending) { skippedPending++; continue; }
      const where = `${locale}/playbooks/${slug}`;
      scanForLeaks(where, content);
      scanForLeaks(where + "#fm", JSON.stringify(data));
      out.playbooks.push({
        id: `playbook:${locale}:${slug}`,
        type: "playbook",
        locale, slug,
        category: data.category ?? null,
        ...clean(data),
        body: content.trim(),
      });
    }
  }

  const recipesRoot = join(CONTENT_DIR, "recipes");
  if (existsSync(recipesRoot)) {
    const phases = (await readdir(recipesRoot)).filter((d) => d.startsWith("phase-"));
    for (const phaseDir of phases) {
      for (const file of await listMdx(join(recipesRoot, phaseDir))) {
        const raw = await readFile(join(recipesRoot, phaseDir, file), "utf8");
        const { data, content } = matter(raw);
        const slug = data.slug ?? file.replace(/\.mdx$/, "");
        if (data.coming_soon) continue;
        const where = `recipes/${phaseDir}/${slug}`;
        scanForLeaks(where, content);
        scanForLeaks(where + "#fm", JSON.stringify(data));
        out.recipes.push({
          id: `recipe:${slug}`,
          type: "recipe",
          slug,
          phase: Number(data.phase ?? 0),
          ...clean(data),
          tier: data.tier ?? "free",
          prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites : [],
          body: content.trim(),
        });
      }
    }
  }

  if (leaks.length > 0) {
    console.error(`\n[bundle] LEAK GATE FAILED — ${leaks.length} suspected secret(s):`);
    for (const l of leaks.slice(0, 20)) {
      console.error(`  - ${l.where}  [${l.pattern}]  ${l.sample}`);
    }
    console.error(`\n[bundle] Aborting. If it is a teaching placeholder, make it`);
    console.error(`[bundle] obviously fake (xxx / <key> / ...).`);
    process.exit(1);
  }

  out.lessons.sort((a, b) => a.locale.localeCompare(b.locale) || a.level - b.level || a.order - b.order);
  out.playbooks.sort((a, b) => a.locale.localeCompare(b.locale) || a.order - b.order);
  out.recipes.sort((a, b) => a.phase - b.phase || a.order - b.order);

  const bundle = {
    schema: 1,
    generatedAt: process.env.BUNDLE_DATE || new Date().toISOString().slice(0, 10),
    source: "https://studiomeyer.academy",
    license: "course content (c) StudioMeyer — code MIT",
    counts: {
      lessons: out.lessons.length,
      playbooks: out.playbooks.length,
      recipes: out.recipes.length,
    },
    ...out,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(bundle), "utf8");

  const kb = Math.round((await readFile(OUT_FILE)).length / 1024);
  console.error(`[bundle] OK wrote ${OUT_FILE} (${kb} KB)`);
  console.error(`[bundle]    lessons=${bundle.counts.lessons} playbooks=${bundle.counts.playbooks} recipes=${bundle.counts.recipes} (skipped ${skippedPending} body_pending)`);
  console.error(`[bundle]    leak gate: clean`);
}

build().catch((e) => {
  console.error("[bundle] fatal:", e);
  process.exit(1);
});
