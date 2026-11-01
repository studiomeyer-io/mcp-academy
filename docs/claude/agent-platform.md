# Academy MCP agent platform

Implementation version: 0.5.0. No publication or deployment is implied.
Local implementation for mcp-academy#48 and Academy#12. This document describes the MCP checkout. Academy owns content, operation definitions, domain logic, pricing and package licensing. Root integration, independent acceptance and deployment remain separate steps.

## One live contract

Default stdio and hosted MCP load `GET {ACADEMY_BASE_URL}/v1`. Its successful envelope exposes `result.operations`: `id`, `description`, `rest`, `mcp.names`, `mcp.deprecatedAliases`, `mcp.annotations`, `inputSchema`, `outputSchema`, `requiredScopes`, `public` and `creditEffect`. Both name lists are string arrays. Schema compilation, name uniqueness and scope validation fail closed. There is no second live tool registry or knowledge bundle in the MCP.

Execution posts `{operation,input,locale}` to `/api/academy/execute`. Locale defaults to `de`; `en` and `es` are accepted. Public operations receive no auth header. Personal operations are identified by `public: false`, including `academy_my_access` with an empty required-scope list. They always revalidate the grant and require the real user Bearer and the existing service token in `X-Academy-Service-Authorization`. Email headers never establish authority. The service independently checks the same token hash, resource, all required scopes, blocked accounts and revoked families.

The upstream output schema describes the service result and may be a valid object union without a top-level type. Every live MCP tool advertises an envelope schema with `type: object` and success/error `oneOf`, nesting that result schema in the success branch. Successful service responses validate `envelope.result`; domain errors validate against the error-envelope branch and never against the success result schema. Runtime input/output validation uses the installed MCP SDK's AJV provider. Local connection and permission failures have stable slugs/codes, hints, documentation URLs and request IDs; upstream domain errors remain intact. Nested quote consent (`consent.userConfirmed`, `consent.quoteId`, `consent.maximumCredits`) does not replace `credits:spend`. Credit actions additionally require `idempotencyKey`. Locale and idempotencyKey are exposed in MCP input schemas but removed before strict service input validation: locale is sent separately in the bridge body and idempotencyKey as the HTTP Idempotency-Key header. Stored approvals and conditional paid flows remain subject to Academy authorization. Only declared deprecated aliases defer legacy field normalization to the strict Root adapter; canonical tools retain local strict input validation.

`academy://docs/quickstart`, `academy://docs/errors` and `academy://docs/package-format` load live machine documentation from the same Academy origin. Confirmed paths are `/quickstart.md`, `/v1/errors` and `/entwickler/paketformat.md`; the actual index `links` map takes precedence. Resource URIs must match exactly; referrer-like strings and query-suffixed resource names are rejected. Documentation responses must be Markdown/plain text, not an HTML fallback.

## Authentication and persistence

Issuer: `https://mcp.studiomeyer.academy`.

Resources are independently selected and immutable:

- MCP: `https://mcp.studiomeyer.academy/mcp`
- REST: `https://studiomeyer.academy/v1`

Scopes: `learn:read`, `learn:write`, `credits:spend`. OAuth supports public DCR clients, exact registered redirects and PKCE S256. The consent form displays only requested scopes and never preselects spending. Consent is tied to an HttpOnly, SameSite=Lax browser nonce and a one-use CSRF proof. HTTPS cookies also use Secure. Magic links must be opened in that browser. Provider state has the same browser/grant binding, and unverified Google/Discord email is rejected. Merely requesting a magic link never writes a user profile.

All relevant code, magic, provider, access and refresh rows carry `scopes TEXT[]`, `resource TEXT`, `grant_version INTEGER` and `consented_at TIMESTAMPTZ`. New consent is version 2. Legacy scope-less records normalize to at most `learn:read`, MCP only, with null consent and no spending. Malformed version-2 grants fail closed.

PostgreSQL is authoritative on every Bearer check. Token hashes remain SHA-256; token plaintext exists only in transit. Code redemption, paired token insertion and consumption commit in one transaction before a token response is returned. Failed validation consumes a code, preventing repeated PKCE guesses. Failed commits roll consumption back and issue no response token.

Refresh selects one stable family lock, then re-reads under that PostgreSQL advisory transaction lock. It may preserve or narrow scopes, never change resource or widen permission. Consumed-token tombstones and family revocations survive restart and concurrency. Replay revokes all descendants, including a concurrent winning rotation. `/revoke` completes its database transaction before returning. Blocking is checked during issuance, refresh and each authenticated execution. Only nonsecurity cleanup uses a background timer.

## Migration and operations

`scripts/schema.sql` is schema version 3. `scripts/oauth-grants-v3.sql` is additive and touches only `academy_mcp_*` tables. It adds grant columns, browser bindings, authorization intents, refresh tombstones and revoked families. The migration runner explicitly supports an existing version 2 database and records version 3 only after migration commit. Unsupported versions or ambiguous unversioned populated databases stop rather than inventing a version.

Before migration: confirm the intended database/host and take a backup when real data exists. Run through the repository's existing migration command, with the configured Academy database. No `db push`, reset, drop, Prisma-owned table change, deployment or real mail is part of this implementation. Runtime secrets remain external. The shared Academy validator must also consult `academy_mcp_oauth_revoked_families`.

A previous compatible deployment can read the still-present legacy columns, but its OAuth code lacks the new authorization guarantees. A code rollback therefore needs security review and must not silently reactivate old personal routes.

## Compatibility

Default stdio now reads live. `--offline` or `ACADEMY_OFFLINE=1` explicitly retains the historical public bundle. It is described as a snapshot and never enables personal tools. Legacy learning/quiz aliases are declared by Academy for the compatibility version. Certificates, XP, rank, leagues and arena are dormant. The retained account facade accepts only a real validated OAuth grant for personal execution; API-key/email values grant no authority. API-key environment configurations receive an explicit migration notice.

The historical smoke script remains unchanged and documents former assumptions. Current verification is `npm test`, `npm run smoke:platform` and `npm run test:auth-db` in addition to `npm run build`.

## Evidence and limits

The builder executed a successful TypeScript/script build, five grant/SDK test groups, ten DB/OAuth tests and a built-process stdio/offline smoke. Real SDK initialization, tools/list and calls use both InMemory and Streamable HTTP transports. DB tests use only the isolated `academy_rebuild` database at loopback port 3431 with synthetic `mcpbuild_*@example.com` identities. They verify negative scopes, audience mismatch, legacy spending denial, refresh narrowing, process restart, persistent replay, parallel redemption/rotation, commit failure, service-secret absence, direct anonymous bypass, browser consent and provider email verification. A scope-check mutation produced two actual assertion failures and was restored.

The additional Root-contract test loads the unmodified 52-operation apiIndex(getAcademyOperations()) export and actual normalizeLegacyInput cases from Academy. Source hashes are recorded in tests/root-fixture-provenance.json. It exercises both credits union variants, zero-scope personal access, nested consent, transport separation, legacy aliases, strict canonical validation and honest SDK envelope output validation. The API server remains a local mock, not the final Root Academy service. Root must perform the genuine shared-service end-to-end test and independent acceptance. No code was deployed or published, and no real mail or payment was sent. The temporary checkout is not indexed: the codebase-index guard forbids `/tmp`. Root indexes the canonical repository after integration.

Rendered OAuth consent HTML was checked in de/en/es, including the unchecked spend option. Check-email and expired-browser responses were exercised with the synthetic mail transport. Final visual/browser acceptance belongs to Root.

## Sources

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP TypeScript SDK v1](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x), installed 1.32.2
- [RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9700 OAuth security](https://www.rfc-editor.org/rfc/rfc9700.html)
- [mcp-academy issue 48](https://github.com/studiomeyer-io/mcp-academy/issues/48)
- [Academy issue 12](https://github.com/studiomeyer-io/academy/issues/12)

## Discovery version

ServerInfo, npm metadata and server.json use 0.5.0; the offline server imports the same VERSION constant. Installed SDK: 1.32.2. Latest protocol: 2025-11-25. Supported protocols from SDK types.js: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07. No package was published.

## Legacy family consistency and quote input unions

A persisted refresh row with family_id NULL uses its paired access_token hash as the family. The corresponding access row uses its own token hash. Rotation, refresh-family lookup, revocation, refresh tombstone insertion and family deletion therefore agree with Root browser disconnect and bearer validation. Explicit modern family_id values are preserved. No data rewrite, grant expansion or schema-version change is required; the additive SQL files document the same fallback rule. A previously rotated legacy access handle can still revoke descendants through their persisted family and tombstone records.

The synthetic PostgreSQL fixture now includes actual NULL-family access/refresh pairs with NULL scopes/consent. Tests verify access- and refresh-handle revocation before rotation, the original access handle after rotation, unchanged modern families and a controlled browser-disconnect race after refresh has already checked revocation. Once browser disconnect commits, both original and newly rotated access and all further refresh are denied. Legacy rotation remains learn:read, MCP only, with null consent. A candidate-family mutation caused two real assertion failures and was restored.

The regenerated real Root index contains 52 operations, including prepareSpend. MCP input schemas add locale/idempotencyKey to strict object branches of oneOf/anyOf/allOf at the same input level, without changing nested service objects or the original service schema. The SDK test validates oneOf and anyOf variants, all PREMIUM/TUTOR/COACHING quote inputs, unknown-field rejection, and POST bridge calls with transport fields separated. Quote preparation neither supplies a flat approval flag nor grants spending authority. Academy's stored-browser-approval denial is preserved as a structured tool error. Removing branch augmentation caused the expected locale/additionalProperties assertion failure and was restored.

The actual v2-to-v3 runner was additionally tested against a populated v2 schema in its own synthetic PostgreSQL namespace. The v2 SQL fixture comes from MCP base commit 04b2273; only comment punctuation was normalized. The real migration preserved token hashes and NULL grant columns, recorded version 3, and allowed only read-only MCP refresh with the paired access hash as family. The fixture rows were removed afterward; shared/public tables were untouched. Reproduce with npm run test:migration-db against the explicitly isolated academy_rebuild database.

## Integrated acceptance

Root tested the built MCP 0.5.0 over real HTTP against the built shared Academy service with synthetic local PostgreSQL fixtures. Public and scope-filtered tool lists, private owner-bound notes, quote preparation, persisted browser approval, a single coaching debit on retry, immediate browser disconnect and legacy quiz-slug reads passed. Independent security and browser reviews returned GO for the tested local scope. Evidence: /home/simple/output/academy-platform-final-2026-11-01/review.html. No live purchase, npm publication or production rollout is implied. The regenerated real Root registry retains 52 operations and all three strict quiz input variants; SDK tests cover each without exposing solutions.

## Production dependency security update

The supplied production audit baseline contained 10 package findings: one critical, four high and five moderate. After targeted compatible updates and the explicitly approved Nodemailer major security fix, npm audit --omit=dev --json returned zero findings of every severity, exit 0. The full local JSON evidence is /tmp/mcp-academy-audit-after-update.json. No --force, audit suppression, application-source rewrite, deployment or publication was used.

| Package | Before | After |
|---|---|---|
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.2 |
| @hono/node-server override | 2.1.1 | 2.1.5 |
| nodemailer | 9.1.1 | 10.3.1 |
| zod | 4.4.3 | 4.6.7 |
| proxy-addr | 2.0.7 | 2.0.8 |
| body-parser | 2.3.0 | 2.4.0 |
| hono | 4.13.7 | 4.13.15 |
| fast-uri | 3.1.7 | 3.1.9 |
| ip-address | 10.5.0 | 10.7.5 |
| qs | 6.16.0 | 6.17.1 |

SDK and Hono ranges now start at the checked safe versions. Nodemailer 9 had no safe 9.x maintainer release; Root explicitly authorized 10.3.1 and the honest Node >=20 engine requirement. Dockerfile already uses node:22-slim, and verification ran on Node 22.22.1. Existing createTransport/sendMail calls remain unchanged. A real buffered streamTransport generated 2926 bytes of MIME for example.invalid through the existing sendMagicLinkEmail function, without SMTP or network delivery.

All requested checks passed with the updated packages: npm test 5/5, npm run build exit 0, isolated OAuth database tests 10/10. Production audit is 0 critical, 0 high, 0 moderate, 0 low, 0 info. No source or test adjustment was necessary. SDK 1.32.2 retains the prior latest/supported protocol list recorded above, so this update introduces no protocol-version discovery change.

Primary advisory references: https://github.com/advisories/GHSA-46jr-4wx8-v453 (SDK resource exhaustion), https://github.com/advisories/GHSA-rmxm-3fg6-px4f (Hono adapter), https://github.com/advisories/GHSA-jqcg-44mw-7w3h (proxy-addr), https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 (Zod), https://github.com/advisories/GHSA-6vj9-mwq6-2f5v and https://github.com/advisories/GHSA-4ffr-jq9g-5ffx (Nodemailer). Version and engine constraints were checked against npm maintainer metadata.

## Pre-deployment merge and runtime SQL contract

The feature branch integrates origin/master at 9c52ddd without lowering SDK 1.32.2, the Hono adapter override 2.1.5, Nodemailer 10.3.1 or Node >=20. Master package fixes are retained: Nodemailer's redundant @types package is removed, Node/tsx/pg minimum patch versions are raised, and the js-yaml argparse override is 2.0.1. A clean npm ci and TypeScript build prove that Nodemailer 10.3.1 resolves its own dist/esm/nodemailer.d.ts declarations; no ambient parent dependency is required. Package/lock conflicts were resolved field by field and the lockfile regenerated from that combined manifest.

The Docker runtime image must contain BOTH /app/scripts/schema.sql and /app/scripts/oauth-grants-v3.sql, alongside /app/dist-scripts/scripts/migrate.js. Dockerfile explicitly copies both SQL inputs into /app/scripts/. The startup command runs the migration before starting the HTTP process. Existing schema-v2 databases need oauth-grants-v3.sql at runtime; compiling TypeScript alone cannot detect a missing COPY. Root's image/runtime gate must verify both readable SQL paths and the existing-v2 migration path before any production build/start is approved. This builder neither builds the Docker image nor deploys it.

Local merge checks: clean npm ci, npm run build, npm test 5/5 and zero production npm audit findings. No application/auth/database source changed, so the existing isolated database proof remains unchanged; Docker build and runtime acceptance belong to Root. The merge is left resolved and staged without a commit or push, with feature HEAD 1a4cff5 and MERGE_HEAD 9c52ddd for Root to commit.


## Production release verification, 2026-11-01

Matthias explicitly approved merging and publishing Academy PR10 and MCP PR50. Both were merged; the deployed MCP source is master1acb9fc and final Academy application source is aae9f71. Deployment used GitHub push/pull and image builds in the production checkouts. A verified, readable full database archive was created on production before additive writes; no production data was transferred to development. The existing schema2 database upgraded to schema3 through the actual built migrator. Both runtime SQL files and the compiled migrator were verified inside the production image against source hashes. The original11 learner accounts,11 progress rows and4 quiz attempts remain present; no commerce record was created.

Both containers are healthy, publish only on loopback3220/3221 and retain768/512MiB memory limits. The existing shared service authorization was preserved; the publisher P256 key was generated persistently only in protected production configuration. The real externally connected MCP SDK initialized0.5.0, listed29 public tools and read all4 paths in Spanish. Personal and spending tools remain absent from the anonymous grant, and the protected endpoint rejects missing authorization. Production proof covers13 REST/MCP/A2A/discovery/privacy checks and4 browser views. Owner-authorized writes and money flows were tested only with isolated synthetic data, not real payments or real learner modifications.

The final full Ora domain audit reports95/100(A+), contract1.38.0, scannedAt2026-11-01T03:32:19.082Z, activeProbes=true, analysisStatus=complete and pendingChecks=[]. This exceeds the approved>90 target and is distinct from the earlier65 baseline and88 intermediate release. Purchases remain disabled because approved business/legal/price configuration is absent; no license or private-package publication is implied. Canonical acceptance artifacts are in /home/simple/output/academy-platform-final-2026-11-01/ on the development host, with sanitized production metadata only. This documentation commit changes no running application source.
