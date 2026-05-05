<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

# mcp-academy

MCP server for **StudioMeyer Academy** — connect Claude Code, Cursor, or Claude Desktop to your learning progress.

- See where you are in the 6-level Memory-First AI Operator curriculum
- Get the next lesson recommended based on your real progress
- Take inline quizzes, submit checkpoints, earn certificates
- Run daily spaced-repetition review directly in your chat
- Talk to the Academy AI-Tutor about the current lesson (Pro only)

Academy lives at <https://academy.studiomeyer.io>.

## A note from us

We have been building tools and systems for ourselves for the past two years. The fact that this repo is small and has few stars is not because it is new. It is because we only just decided to share what we have built. It is not a fresh experiment, it is a long story with a recent commit.

We love building things and sharing them. We do not love social media tactics, growth hacks, or chasing stars and followers. So this repo is small. The code is real, it gets used, issues get answered. Judge for yourself.

If it helps you, sharing, testing, and feedback help us. If it could be better, an issue is more useful. If you build something with it, tell us at hello@studiomeyer.io. That genuinely makes our day.

From a small studio in Palma de Mallorca.

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

## Env Variables

| Var | Required | Default |
|---|---|---|
| `ACADEMY_API_KEY` | yes | — |
| `ACADEMY_BASE_URL` | no | `https://academy.studiomeyer.io` |

Setting `ACADEMY_BASE_URL` is useful if you want to run the MCP server against a local Academy instance (`http://localhost:3220`).

## Privacy

The server never stores anything locally. Every call is a straight HTTPS request to your Academy account, authenticated by the Bearer token you configured. Revoke any key at <https://academy.studiomeyer.io/dashboard/keys>.

## About StudioMeyer

[StudioMeyer](https://studiomeyer.io) is an AI and design studio based in Palma de Mallorca, working with clients worldwide. We build custom websites and AI infrastructure for small and medium businesses. Production stack on Claude Agent SDK, MCP and n8n, with Sentry, Langfuse and LangGraph for observability and an in-house guard layer.

## License

MIT © StudioMeyer.