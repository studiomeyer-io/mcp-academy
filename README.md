<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

# mcp-academy

<!-- badges -->
[![npm version](https://img.shields.io/npm/v/mcp-academy?style=flat-square&color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/mcp-academy)
[![npm downloads](https://img.shields.io/npm/dm/mcp-academy?style=flat-square&color=cb3837&logo=npm&label=installs%2Fmo)](https://www.npmjs.com/package/mcp-academy)
![License](https://img.shields.io/github/license/studiomeyer-io/mcp-academy?style=flat-square&color=22c55e&label=license)
![Last commit](https://img.shields.io/github/last-commit/studiomeyer-io/mcp-academy?style=flat-square&color=88c0d0&label=updated)
![GitHub stars](https://img.shields.io/github/stars/studiomeyer-io/mcp-academy?style=flat-square&color=ffd700&logo=github&label=stars)
<!-- /badges -->

**Take the StudioMeyer Academy "Memory-First AI Operator" course right inside your AI.** Claude, ChatGPT, Cursor or Codex becomes your tutor — it pulls the lessons, explains them, answers your questions, and walks you through building real things.

The whole curriculum ships **inside this package**: 6 levels, ~47 lessons (DE/EN/ES), 48 hands-on playbooks, 61 build recipes. **No account, no API key, no database, no network needed to learn.** It's free and open source.

- **Levels 1–3** — fundamentals: what LLMs really do, prompting, simple automation.
- **Levels 4–6** — the part almost nobody teaches: persistent memory, the MCP protocol, hooks & skills, multi-agent systems, and building + selling your own MCP server.

Academy lives at <https://studiomeyer.academy>.

## A note from us

We have been building tools and systems for ourselves for the past two years. The fact that this repo is small and has few stars is not because it is new. It is because we only just decided to share what we have built. It is not a fresh experiment, it is a long story with a recent commit.

We love building things and sharing them. We do not love social media tactics, growth hacks, or chasing stars and followers. So this repo is small. The code is real, it gets used, issues get answered. Judge for yourself.

From a small studio in Palma de Mallorca.

## Quick start

### Claude Code

```bash
claude mcp add academy -s user -- npx -y mcp-academy
```

Then just say: *"Start the Academy."* Your assistant calls `academy_welcome` and you're learning.

### Cursor / Claude Desktop / Codex

```json
{
  "mcpServers": {
    "academy": {
      "command": "npx",
      "args": ["-y", "mcp-academy"]
    }
  }
}
```

### ChatGPT (and other remote connectors)

ChatGPT connects to a hosted URL, not a local command. Add a connector pointing at:

```
https://mcp.studiomeyer.academy/mcp
```

No authentication needed — it's a public, read-only learning server. (Settings → Connectors / Developer mode → add the URL above.) ChatGPT then uses `search` + `fetch` to read the course and teach it to you.

## What you can do (free, no account)

| Tool | What it does |
|------|--------------|
| `academy_welcome` | Orientation — call this first |
| `academy_levels` | The 6-level learning path |
| `academy_lessons` / `academy_lesson` | List a level / read a full lesson |
| `academy_playbooks` / `academy_playbook` | Hands-on how-tos |
| `academy_recipes` / `academy_recipe` | Step-by-step build guides |
| `academy_search` | Search the whole curriculum |
| `academy_tutor_context` | Get a lesson packaged for tutoring — your AI teaches it |
| `search` / `fetch` | The ChatGPT connector contract (read course material) |

All locales: `de`, `en`, `es` (default `en`).

## Optional: track your progress (account)

If you have a [studiomeyer.academy](https://studiomeyer.academy) account, add your API key over **stdio** to unlock personal progress, quizzes, spaced-repetition and certificates:

```bash
claude mcp add academy -s user --env ACADEMY_API_KEY=academy_xxx -- npx -y mcp-academy
```

Create a key at <https://studiomeyer.academy/dashboard/keys>. This adds: `academy_stats`, `academy_next_lesson`, `academy_progress_complete`, `academy_quiz`, `academy_quiz_submit`, `academy_review`, `academy_review_grade`, `academy_certificates`, `academy_tutor` (Pro). These talk to the Academy REST bridge with your Bearer token — and are only ever available over stdio, never on the public HTTP endpoint.

> `ACADEMY_BASE_URL` defaults to `https://studiomeyer.academy` and should only ever point at the real Academy origin (it's where your key is sent). Useful for pointing at a local Academy instance during development.

## Run your own HTTP endpoint

```bash
PORT=8080 npx -y mcp-academy --http     # public, anonymous, read-only at /mcp
```

Stateless Streamable HTTP, one isolated session per request. Put it behind a reverse proxy / Cloudflare. The HTTP mode never reads `ACADEMY_API_KEY` (a shared hosted key would expose one account to everyone).

## How it stays fresh & safe

The curriculum is baked into the package at build time from the live Academy content (`npm run bundle`), behind a hard source whitelist + a secret-leak gate that aborts the build on any real-looking credential. Quiz answer keys and the AI-tutor system prompt are **never** bundled — they live server-side and are only reachable with your own account key.

## About StudioMeyer

[StudioMeyer](https://studiomeyer.io) is an AI and design studio in Palma de Mallorca, working with clients worldwide. We build custom websites and AI infrastructure for small and medium businesses. Source: [studiomeyer-io/mcp-academy](https://github.com/studiomeyer-io/mcp-academy). Issues and PRs welcome — hello@studiomeyer.io.

## License

MIT © StudioMeyer
