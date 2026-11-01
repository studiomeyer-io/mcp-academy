# mcp-academy

Implementation version: 0.6.0. No publication or deployment is implied.
StudioMeyer Academy in your AI client. Public learning paths, lessons, library content and search are read live from [Academy](https://studiomeyer.academy). German is the default; English and Spanish are supported.

Connect without signing in:

```text
https://mcp.studiomeyer.academy/mcp?access=free
```

Connect with OAuth for personal learning, notes, quizzes, purchased content and credits:

```text
https://mcp.studiomeyer.academy/mcp
```

The protected endpoint returns `401` with OAuth discovery. Public clients use PKCE S256 and no client secret. The person selects `learn:read`, `learn:write` and, optionally, `credits:spend`. Spending is unchecked by default. Each credit operation also needs the service-declared quote consent (`consent.userConfirmed`, `consent.quoteId`, `consent.maximumCredits`) and a unique `idempotencyKey`; show the current quote first. Stored spending approvals remain Academy business rules. `academy_my_access` describes the actual grant.

Agent integration instructions: [AGENTS.md](./AGENTS.md). Agent Plugins 1.0.0: [plugin.json](./plugin.json) and [mcp.json](./mcp.json). The plugin uses the standard remote Streamable HTTP transport and the existing OAuth-protected endpoint; no credentials are embedded.

Where authorization-server metadata advertises `agent_auth`, an agent can register anonymously and later be claimed by the intended human. Anonymous access has **no personal scopes**: `learn:read` exposes private Academy records and is never anonymous. The claim verifies the intended email in the same browser, requires the code supplied by the agent and lets the person select learning permissions. Spending is absent and requires a separate ordinary OAuth connection. The free endpoint above remains available without any registration.

## Local MCP clients

Requires Node.js 20 or newer. The hosted Docker image uses Node.js 22.

Build the current implementation from source:

```bash
git clone https://github.com/studiomeyer-io/mcp-academy.git
cd mcp-academy
npm ci
npm run build
node dist/index.js
```

The npm package `mcp-academy` is still 0.4.1; repository and hosted server are 0.6.0. `npx -y mcp-academy` installs the older published package and does not provide the current live-default contract. No new npm version has been published.

Default stdio is live and public. It requires network access to Academy. For Claude Desktop, Cursor or another stdio client:

```json
{
  "mcpServers": {
    "academy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-academy/dist/index.js"]
    }
  }
}
```

Start with `academy_start`. Tool names, result schemas, public/account visibility, annotations, required scopes and deprecated aliases come from the live [operation registry](https://studiomeyer.academy/v1). Personal tools are absent from the free tool list and cannot be invoked directly without permission. Old learning and quiz names remain available only as the aliases declared by that registry for the compatibility version. Certificates, XP, rankings and arena remain dormant.

For the preserved historical curriculum snapshot, explicitly opt in:

```bash
node dist/index.js --offline
# Alternative: ACADEMY_OFFLINE=1 node dist/index.js
```

The offline library is read-only, can be outdated and needs no network or account. Its old level names describe that snapshot, not today's live Academy. `ACADEMY_API_KEY` no longer grants personal access; existing configurations receive a migration notice. Use the hosted OAuth connection for personal tools.

## Live documentation

MCP resources:

- `academy://docs/quickstart`
- `academy://docs/errors`
- `academy://docs/package-format`

These read Academy's machine documents at request time. The service output schema describes `result`. Each MCP tool wraps it in an honest success/error envelope schema with `type: object` and `oneOf`. `locale` and `idempotencyKey` are MCP transport fields: locale goes into the bridge envelope, and the key becomes the HTTP `Idempotency-Key` header; neither is added to strict service input. Tool results carry the same `{success,result,errors,messages,request_id}` envelope as REST in `structuredContent` and text, with `isError` set for failures. Errors include stable `code`, `slug`, `message`, `hint` and `documentation_url` fields. Unknown tool names and arguments that violate the published schema are JSON-RPC `-32602` errors with an English protocol message and the localized Academy envelope in `error.data`. Execution failures, missing content and paywalls remain `isError` results. OAuth endpoints retain their standard OAuth error format.

## Hosted configuration

Run the HTTP service behind the existing reverse proxy, bound to loopback:

```bash
npm ci
npm run build
npm run db:schema
npm run start:http
```

`db:schema` must point at the intended Academy database. On databases containing real data, take a verified backup before applying the additive migration. The runner checks the configured host and `current_database()` and supports fresh schema v4 and the additive v2 to v3 to v4 and v3 to v4 transitions. It never runs Prisma migrations or removes tables. No deployment or publication is implied by these commands.

| Environment | Purpose |
|---|---|
| `ACADEMY_BASE_URL` | Trusted Academy origin; defaults to `https://studiomeyer.academy`. Only HTTPS or loopback HTTP is accepted. |
| `ACADEMY_MCP_DATABASE_URL` | Academy's shared database containing `academy_mcp_*` OAuth tables. |
| `ACADEMY_MCP_SERVICE_TOKEN` | Additional service authorization for personal execute calls. It never substitutes for the user's access token. |
| `ACADEMY_MCP_BASE_URL` | Public issuer URL, `https://mcp.studiomeyer.academy`. |
| `ACADEMY_MCP_HOST` / `ACADEMY_MCP_PORT` | Bind address and port; defaults `127.0.0.1:3116`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Existing magic-link mail configuration. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google login. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Optional Discord login. |
| `ACADEMY_AGENT_ASSERTION_SECRET` | Dedicated persistent random signing secret, at least 32 random bytes encoded as base64url. Enables the anonymous registration/claim profile; do not reuse other service credentials. |
| `ACADEMY_MCP_TRUSTED_IP_HEADER` | Existing reverse-proxy IP policy; configure only with a verified trusted proxy. |

A personal call sends the real user Bearer plus `X-Academy-Service-Authorization: Bearer <service token>` to `/api/academy/execute`. Public calls send neither. Academy independently checks audience, scopes, revocation and blocking against the same database. The MCP and REST resources are distinct: `https://mcp.studiomeyer.academy/mcp` and `https://studiomeyer.academy/v1`.

## Verification

```bash
npm run build
npm test
npm run smoke:platform
# With only the isolated test database configured:
npm run test:auth-db
npm run test:migration-db
npm run test:agent-identity-db
npm run test:agent-protocol
```

The DB tests require exactly `127.0.0.1:3431/academy_rebuild` and use synthetic `example.com` identities. They cover real transactions, restart, parallel redemption, refresh replay, narrowing, audience checks, revocation, browser binding and consent. Mail is replaced with a test transport. The SDK tests include a 52-operation index fixture imported from the actual Academy registry and real legacy-input normalization fixtures, with source hashes recorded in `tests/root-fixture-provenance.json`. They cover object-union credit results and personal zero-scope access. The SDK tests use a local mock Academy API; they do not claim a completed cross-repository integration or live deployment.

`npm run smoke` and `npm run smoke:platform` both run the current live-default/explicit-offline CLI harness. `npm run smoke:legacy` retains the older historical harness; its implicit-offline, all-authenticated hosted and API-key expectations describe the previous product.

The server code is MIT licensed. Content licensing comes from Academy's content/package metadata; this package does not establish new rights for Academy content.

Implementation details, integration evidence and deployment boundaries: [agent platform contract](docs/claude/agent-platform.md).

## Optional focused docs entry

The current checkout adds `https://mcp.studiomeyer.academy/mcp?access=docs` as an anonymous Streamable HTTP entry with exactly `search` and `fetch`. This addition is locally implemented and reviewed; production availability and an external Ora check still require deployment and verification. It does not change the existing `?access=free` entry, personal OAuth entry or declared legacy aliases. Academy discovery adds `docs_remote` separately; `public_remote` continues to point at `?access=free`.

Docs mode rejects every other tool name with the existing JSON-RPC `-32602` / `not_found` error before execution. Search IDs can be passed to `fetch`, with the same public content/envelope as free mode. The existing three documentation resources remain available. Docs requests use the shared anonymous free/docs IP budget and never forward personal credentials.

The archived registry fixture contains 52 operations, 56 MCP names including aliases and 29 public tools. The live registry snapshot checked on 2026-11-01 contains 53 operations, 29 public names and 28 personal names. Runtime `tools/list` remains authoritative. No tool was removed or renamed; every output schema remains self-contained.
