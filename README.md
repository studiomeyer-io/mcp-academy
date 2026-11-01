# mcp-academy

Implementation version: 0.5.0. No publication or deployment is implied.
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

## Local MCP clients

```bash
npx -y mcp-academy
```

Default stdio is live and public. It requires network access to Academy. For Claude Desktop, Cursor or another stdio client:

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

Start with `academy_start`. Tool names, result schemas, public/account visibility, annotations, required scopes and deprecated aliases come from the live [operation registry](https://studiomeyer.academy/v1). Personal tools are absent from the free tool list and cannot be invoked directly without permission. Old learning and quiz names remain available only as the aliases declared by that registry for the compatibility version. Certificates, XP, rankings and arena remain dormant.

For the preserved historical curriculum snapshot, explicitly opt in:

```bash
npx -y mcp-academy --offline
# Alternative: ACADEMY_OFFLINE=1 npx -y mcp-academy
```

The offline library is read-only, can be outdated and needs no network or account. Its old level names describe that snapshot, not today's live Academy. `ACADEMY_API_KEY` no longer grants personal access; existing configurations receive a migration notice. Use the hosted OAuth connection for personal tools.

## Live documentation

MCP resources:

- `academy://docs/quickstart`
- `academy://docs/errors`
- `academy://docs/package-format`

These read Academy's machine documents at request time. The service output schema describes `result`. Each MCP tool wraps it in an honest success/error envelope schema with `type: object` and `oneOf`. `locale` and `idempotencyKey` are MCP transport fields: locale goes into the bridge envelope, and the key becomes the HTTP `Idempotency-Key` header; neither is added to strict service input. Tool results carry the same `{success,result,errors,messages,request_id}` envelope as REST in `structuredContent` and text, with `isError` set for failures. Errors include stable `code`, `slug`, `message`, `hint` and `documentation_url` fields. OAuth endpoints retain their standard OAuth error format.

## Hosted configuration

Run the HTTP service behind the existing reverse proxy, bound to loopback:

```bash
npm ci
npm run build
npm run db:schema
npm run start:http
```

`db:schema` must point at the intended Academy database. On databases containing real data, take a verified backup before applying the additive migration. The runner checks the configured host and `current_database()` and supports the explicit schema v2 to v3 transition. It never runs Prisma migrations or removes tables. No deployment or publication is implied by these commands.

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
```

The DB tests require exactly `127.0.0.1:3431/academy_rebuild` and use synthetic `example.com` identities. They cover real transactions, restart, parallel redemption, refresh replay, narrowing, audience checks, revocation, browser binding and consent. Mail is replaced with a test transport. The SDK tests include a 52-operation index fixture imported from the actual Academy registry and real legacy-input normalization fixtures, with source hashes recorded in `tests/root-fixture-provenance.json`. They cover object-union credit results and personal zero-scope access. The SDK tests use a local mock Academy API; they do not claim a completed cross-repository integration or live deployment.

The older `npm run smoke` script is retained unchanged as a historical contract check. Its implicit-offline, all-authenticated hosted and API-key expectations describe the previous product; `smoke:platform` verifies the rebuilt contract.

The server code is MIT licensed. Content licensing comes from Academy's content/package metadata; this package does not establish new rights for Academy content.

Implementation details, integration evidence and deployment boundaries: [agent platform contract](docs/claude/agent-platform.md).
