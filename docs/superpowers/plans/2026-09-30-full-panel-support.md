# Full panel MCP support

**Goal:** Support every authenticated section of the current Operbots panel on branch `feat/full-panel-support`, and verify actual tool inputs, HTTP calls, safety boundaries and packaged MCP startup.

**Architecture:** Keep the existing declarative `Tool` groups and the `Context`, `AuthManager` and `OperbotsApi` classes. Add domain tools with explicit validated inputs. Reuse backend authorization; keep destructive confirmations, optimistic revisions and secret masking. Use native Node HTTP, FormData, filesystem and `node:test`; add no dependencies.

**Tech Stack:** TypeScript, Zod, MCP SDK, Node >=20; Python/FastAPI backend as the API contract.

**Spec:** User requested all panel sections, including Requests and connected mechanisms, plus a new MCP branch. The current backend routes and schemas define available operations. Browser authentication, token issuance and second factor enrollment retain their session-only security boundary.

## Global Constraints

- Preserve unrelated panel changes and production data.
- Read-only mode must not mutate panel state, including history read counters.
- Never silently refresh revision/version arguments before mutations.
- Editing existing resources must preserve omitted data and presentation settings.
- File transfers use explicit absolute paths; downloads never overwrite existing files.
- Do not publish packages, push branches, or transmit secrets in test output.

## Review Focus

Ambiguous resource references; input fields omitted by old tools; mutation through read tools; cross-account caches; error propagation; extension secret preservation; file transfer timeouts; stale revisions; complete discovery and startup in both plugin packages.

## Tasks

1. Baseline and coverage: map every route to a tool or a documented browser/platform transport boundary. Baseline typecheck, build, and plugin smoke tests. Expected: baseline passes; omissions are recorded.
2. Add Requests and Counterparties; complete Flow, Dialog, Broadcast and catalog contracts; add Extensions, Notifications, AI usage and remaining account/team/bot/market/knowledge operations. Write meaningful failing native tests before each implementation. Expected: exact route/body assertions, validation and confirmation cases pass.
3. Extend the existing HTTP client for multipart uploads and binary downloads; repair shared auth/cache/safety defects found by audit. Expected: local HTTP tests pass for JSON, multipart, bytes, timeout/errors and no overwrite.
4. Register tools, refresh descriptions and README coverage, wire native tests into npm scripts, rebuild both plugin bundles. Expected: typecheck, domain/core/protocol tests and packaged stdio handshake pass.
5. Review the complete branch with a fresh reviewer, repair material findings, run final checks and report the branch and measured results. Keep integration boundaries explicit.

## Progress

- Branch `feat/full-panel-support` created from clean `main`.
- Baseline: typecheck, build and 5 packaged SDK stdio checks passed.
- API and core audits run independently. Implementation file ownership is separated by domain; root owns registration, documentation, Extensions, Notifications, AI usage and remaining groups.
- Found regressions to cover: lost flow comments; missing request/counterparty/extension permissions; history read counter mutation in read-only mode; omitted dialog/broadcast fields and operations.
- Implemented 143 tools (baseline 82); 56 available in read-only mode, 31 marked danger. Requests, Counterparties, Extensions, Notifications and AI usage now have complete token-accessible operations; existing groups preserve all current write fields and card metadata.
- Preserved declarative groups and Context/AuthManager/OperbotsApi classes; no dependencies added. Native multipart and file downloads reject overwrite, network/device paths and redirect forwarding. Secrets are entered through CLI/explicit local files, never MCP form elicitation.
- Fresh reviewer checked the complete branch and backend contracts. Reproduced and fixed ambiguous chat/reply/flow/broadcast selection, incomplete-page selection, community card mutation, credential reload caches, redirect forwarding and file-path guards. Browser-only token/2FA ceremonies and platform transports are documented boundaries.
- Real SDK stdio -> HTTP -> disposable PostgreSQL: 57 checks passed, covering owner/viewer/read-only, case isolation, optimistic revisions, request lifecycle, counterparty links, extensions, notifications, canvas preservation, draft audience reset and knowledge documents. All 33 migrations passed. QA server/container/temp credentials removed; five primary Docker services remain healthy.
- Final verification: `npm run typecheck` passed; `npm test` rebuilt the plugin bundle and passed 118 native tests plus 5 packaged Codex/Claude Code checks; `git diff --check` clean. Fresh reviewer confirmed no material findings remain in the fixed paths (55 core/dialog checks and the account-switch regression passed independently).
- Work remains on the requested local branch; no release, remote push or merge.
