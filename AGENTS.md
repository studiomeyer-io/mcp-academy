# StudioMeyer Academy for coding agents

Kurz auf Deutsch: Lernen ist kostenlos. Persönliche Daten und Credits benötigen die ausdrücklich freigegebenen Berechtigungen eines Menschen.

StudioMeyer Academy offers free public learning paths, lessons, search and library content. German is the default; use `locale: "en"` or `"es"` when requested. Start with `academy_start`, then follow the live registry and schemas. Do not invent courses, offers, credit prices or availability.

## Connections and discovery

- Public MCP: `https://mcp.studiomeyer.academy/mcp?access=free`
- Personal MCP with OAuth: `https://mcp.studiomeyer.academy/mcp`
- REST operation registry: `https://studiomeyer.academy/v1`
- OpenAPI: `https://studiomeyer.academy/v1/openapi.json`
- Authentication walkthrough: `https://studiomeyer.academy/auth.md`
- Agent Plugins manifest: [plugin.json](./plugin.json), with the remote Streamable HTTP server in [mcp.json](./mcp.json).

Read current tools/list and output schemas. The default public tool list stays intact; aliases are declared by the service. The optional offline library is a historical snapshot, not current service availability.

## Identity and permission boundaries

Normal OAuth uses public clients, PKCE S256 and exact registered redirect URIs. A human selects `learn:read` for personal records and `learn:write` for saving learning activity. `credits:spend` is unchecked by default and never follows from either learning scope. Inspect actual permissions with `academy_my_access` after connecting.

Where AS metadata advertises `agent_auth`, anonymous agent registration grants no personal scopes. An anonymous token permits public content only. The human-claim ceremony requires the intended person's verified email, the agent's code and explicit learning-scope consent in the same browser. Claiming never grants spending. External identity assertions, service-auth identities and security-event delivery are not advertised or accepted as substitutes for human approval.

Before spending, prepare the server-priced quote, show the person its content and credit amount, then have the person approve that concrete quote at `https://studiomeyer.academy/dashboard/agent`. Invoke the operation with its declared `consent` (`userConfirmed`, `quoteId`, `maximumCredits`) and `idempotencyKey`. MCP forwards that key as the HTTP `Idempotency-Key`. A chat message alone does not create stored browser approval. Reuse the same key and payload for retries. An uncertain result must be investigated before any new purchase or spend. Bonus credits must never fund coaching.

## Errors

Tool execution returns an Academy envelope in both structuredContent and text: `{success,result,errors,messages,request_id}`. Error entries have `code`, `slug`, `message`, `hint`, and `documentation_url`. Domain errors, including paywalls, remain tool results with `isError: true`. A paywall is not permission to buy: surface the hint and obtain the required separate human approval.

Unknown tool names and arguments that violate the declared input schema use JSON-RPC `-32602`, an English protocol message, and the localized Academy envelope in `error.data`. OAuth endpoints retain OAuth error vocabulary.

## Contributions

Use strict TypeScript and preserve existing public tools and OAuth compatibility. Run `npm test` and `npm run test:agent-protocol`; run `npm run build` in an isolated checkout. Database suites require the explicitly documented isolated test database and synthetic users only. No production migration, deployment, publication, message or real charge follows from a code change. Update [the canonical contract](./docs/claude/agent-platform.md) with relevant behavior and evidence. Descriptor versions must agree with package.json and the server VERSION constant.
