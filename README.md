# mcp-academy

MCP server for **StudioMeyer Academy** — connect Claude Code, Cursor, or Claude Desktop to your learning progress and the AI-Operator Recipe Stack.

- See where you are in the 6-level Memory-First AI Operator curriculum (free)
- Walk 74 step-by-step Recipes covering CLAUDE.md, Skills, MCP-server building, OAuth, Multi-Tenant SaaS — with per-step Validators that check whether what you just did actually worked
- Browse the Knowledge Graph (32 Concepts + 27 Relations covering CLAUDE.md, agents.md, OAuth-PKCE, MCPize, Multi-Tenant, Operator Skills, ...)
- Get the next lesson or recipe recommended based on your real progress
- Take inline quizzes, submit checkpoints, earn certificates
- Run daily spaced-repetition review directly in your chat
- Talk to the Academy AI-Tutor about the current lesson (Pro only)

Academy lives at <https://studiomeyer.academy> (and <https://academy.studiomeyer.io>).

> **v0.2.0 update (2026-04-25):** Added 10 Recipe + Knowledge-Graph tools. Recipes Phase 1-5 free, Phase 6-10 require Pro subscription, Phase 11-15 coming-soon. Lessons stay free forever.

## Install

```bash
npm install -g mcp-academy
```

Or run without installing:

```bash
npx -y mcp-academy
```

## Setup

1. Log in at <https://academy.studiomeyer.io/dashboard/keys>
2. Create a new API key (e.g. "Claude Code Desktop")
3. Copy the token — it starts with `academy_...`
4. Wire it into your MCP-capable client.

### Claude Code

```bash
claude mcp add academy \
  -s user \
  --env ACADEMY_API_KEY=academy_your_token_here \
  -- npx -y mcp-academy
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "academy": {
      "command": "npx",
      "args": ["-y", "mcp-academy"],
      "env": {
        "ACADEMY_API_KEY": "academy_your_token_here"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "academy": {
      "command": "npx",
      "args": ["-y", "mcp-academy"],
      "env": { "ACADEMY_API_KEY": "academy_your_token_here" }
    }
  }
}
```

## Tools

23 tools total — 13 Lessons + 10 Recipes / Knowledge-Graph.

### Lessons (13)

| Tool | Description |
|---|---|
| `academy_stats` | Your XP, rank, streak, badges, certificates, weekly league standing. |
| `academy_levels` | All 6 levels with access info (free / paid / earned). |
| `academy_lessons` | List lessons in a level with completed status. |
| `academy_lesson` | Get full content of a specific lesson. |
| `academy_next_lesson` | Recommend the next incomplete lesson based on progress. |
| `academy_progress_complete` | Mark a lesson as completed — grants XP, updates streak, schedules review. |
| `academy_quiz` | Fetch a lesson quiz or level-checkpoint quiz. |
| `academy_quiz_submit` | Submit answers. Returns score + per-question feedback. Checkpoint pass → certificate. |
| `academy_review` | Items due for spaced-repetition today. |
| `academy_review_grade` | Grade a review item (again / good / easy) — SM-2 schedules next review. |
| `academy_certificates` | Your earned certificates with public verification URLs. |
| `academy_tutor` | Ask the AI-Tutor. Context-aware if you pass level + lessonSlug. Pro only. |
| `academy_tutor_quota` | Check tutor usage / daily limits. |

### Recipes + Knowledge-Graph (10, new in v0.2.0)

| Tool | Description |
|---|---|
| `academy_list_recipes` | List recipes filtered by phase / tier / locked-flag. Returns 74 recipes with status (completed / in_progress / not_started / locked / coming_soon). |
| `academy_get_recipe` | Get a recipe with full step bodies + per-step `clientCheck` (Bash command + expected output). Locked recipes return a teaser + upgradeUrl. |
| `academy_start_recipe` | Begin a recipe. Idempotent — completed recipes return `already_completed` unless `restart: true`. |
| `academy_next_step` | Get the active recipe's current step including the `clientCheck` snippet. |
| `academy_validate_step` | First call returns `client_check_required` + the Bash snippet. The LLM runs the snippet locally. Second call with `manual: true` advances the step. Last step → `recipeCompleted: true`. |
| `academy_my_recipes` | Per-phase progress stats + active recipe + recommended next. |
| `academy_save_recipe_note` | Save a per-step note for a recipe. |
| `academy_concept_search` | Trigram + ILIKE fuzzy search across the 32-concept knowledge graph. |
| `academy_concept_open` | Get a concept with body + outgoing/incoming relations + recent observations. Pro-tier bodies gated to active subscribers. |
| `academy_concept_graph` | N-hop BFS traversal from a root concept (depth 1-3). |

## Env Variables

| Var | Required | Default |
|---|---|---|
| `ACADEMY_API_KEY` | yes | — |
| `ACADEMY_BASE_URL` | no | `https://academy.studiomeyer.io` |

Setting `ACADEMY_BASE_URL` is useful if you want to run the MCP server against a local Academy instance (`http://localhost:3220`).

## Privacy

The server never stores anything locally. Every call is a straight HTTPS request to your Academy account, authenticated by the Bearer token you configured. Revoke any key at <https://academy.studiomeyer.io/dashboard/keys>.

## License

MIT © StudioMeyer.
