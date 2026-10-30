# pi-mcp-adapter compatibility and safety research (T8)

Unit T8 of ODD `agent-session-workspace` (spec S6). Read-only research: package
metadata, source inspection, SDK API comparison against
`@earendil-works/pi-coding-agent@0.80.3` (pinned in `packages/runner/package.json`
and `packages/manager/package.json`), and a risk register for installing the
package by default. No code was changed and nothing was installed.

## Verdict

**Install by default: NO.** Two independent blockers:

1. **Hard SDK incompatibility.** `pi-mcp-adapter@7.0.0` declares
   `peerDependencies["@earendil-works/pi-ai"] = "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.99.0 || ^1.0.0"`.
   pi-hub pins `pi-coding-agent@0.80.3`, which resolves `pi-ai@0.80.3` — outside
   the supported range — and the adapter's own documentation tiers its behaviour
   by Pi version ("On Pi 0.84 to 0.87…", "On Pi 0.99 and later…"); no 0.80 tier
   exists.
2. **Inverted policy.** The product goal is an admin-controlled MCP allowlist
   (users must stop adding MCP servers freely). The adapter's design is the
   opposite: it adds unmanaged configuration surfaces (`mcp({ action: "install",
   url })`, `/mcp-adapter setup`, `.mcp.json`, `~/.config/mcp/mcp.json`,
   `~/.agents/mcp.json`, imports from Cursor/Claude Code/Codex/VS Code) with a
   nine-tier file precedence. pi-hub has no package-source allowlist today, so
   nothing in the adapter would be enforced.

## Package metadata (facts)

| Field | Value |
| --- | --- |
| Name / version | `pi-mcp-adapter` / 7.0.0 |
| Author | Nico Bailon (`nicobailon`) — third party, not the Pi author |
| Repository | github.com/nicobailon/pi-mcp-adapter (MIT) |
| Published | 2026-10-26; ~1.4M downloads/month |
| Engines | node >=20 (pi-hub's SDK requires >=22.19.0) |
| Pi manifest | `"pi": { "extensions": ["./index.ts"] }` — TypeScript source extension loaded at runtime (jiti) |
| Peer deps | `pi-ai` (optional) as above; `pi-tui *`; `typebox *`; `zod ^3\|\|^4` |
| Runtime deps (13) | `@modelcontextprotocol/{client,core}@2.3.1`, `@napi-rs/keyring ^2.1.0` (native binary), `undici@6` (0.80.3 ships undici 8.5.0 — duplicate copy), `cross-spawn`, `open`, `ajv`, `smol-toml`, `recheck@4.6.0-beta.3` (beta) |
| Size | 4.8 MB unpacked, 269 files |

Sources: pi.dev package page, npm registry `latest` payload, GitHub `main`
branch (package.json, README, docs/configuration.md, docs/servers.md,
docs/extension-api.md, docs/auth.md, docs/prompts-and-ui.md).

## SDK API comparison against 0.80.3 (facts)

Verified against the published `@earendil-works/pi-coding-agent@0.80.3` `.d.ts`
(unpkg.com), because the workspace has no installed `node_modules` to inspect.

| Adapter needs | In 0.80.3 |
| --- | --- |
| `withFileMutationQueue` | yes |
| `AgentToolResult`, `AgentToolUpdateCallback` | yes |
| `ExtensionAPI`, `ExtensionContext` | yes |
| `ToolInfo` | yes |
| `ToolDefinition.renderShell` | yes |
| `pi.getAllTools/getActiveTools/setActiveTools/getCommands/events` | yes |
| `ctx.isProjectTrusted()`, `project_trust` event | yes |
| `ExtensionToolContext` (type) | **no** (0.80.3 has `ExtensionContext`, `ExtensionCommandContext`) |
| `RegisteredMcpServer` (type) | **no** |
| `ToolDefinition.exposure: "hidden"/"deferred"` | **no** — adapter's fallback (`registerTool` with the field) is silently ignored by 0.80.3 |
| `pi.unregisterTool` | **no** — adapter feature-detects and falls back to re-registering "hidden" tools, which is ineffective on 0.80.3 |
| `pi.registerMcpServer` (0.99+ path) | **no** |
| peer range `pi-ai ^0.84.1+` | **no** — 0.80.3 installed |

Inference (clearly labelled): all missing symbols except `exposure` and
`unregisterTool` are type-only, erased at load, so the extension would probably
*load* on 0.80.3 with degraded semantics — hidden/deferred/unregister paths all
no-op and every documented 0.99+ behaviour unavailable. Whether
`createMcpAdapter()` / `createHostManagedMcpAdapter()` load on 0.80.3 (their
documented embedding uses `DefaultResourceLoader({ extensionFactories })`) is
**unverified**.

## How pi-hub installs packages today (facts)

- Declared per-agent surface: `packages: []` in agent `settings.json`;
  read by `packages/shared/src/pi.ts:118-131` (`readPackageSources`),
  surfaced by `packages/manager/src/agents.ts:124-141` and
  `packages/manager/src/bootstrap.ts:19-27`.
- Install/remove shells out to the real `pi` CLI (`piInstall`/`piRemove`,
  `packages/shared/src/pi.ts:38-72`) with
  `PI_CODING_AGENT_DIR=<dataDir>/global` and per-agent
  `PI_CODING_AGENT_SESSION_DIR`.
- Global default packages: `PIHUB_GLOBAL_PACKAGES` env → `globalPackages`
  (`packages/shared/src/env.ts`), installed in `bootstrap()`
  (`packages/manager/src/bootstrap.ts`).
- Per-agent changes: creation defaults, declarative provisioning
  (`packages/manager/src/provision.ts`), reconcile via
  `PUT /api/v1/agents/:name/packages` and single add/remove
  (`packages/manager/src/api-v1/routes.ts`).
- **Open hole:** `packages/runner/src/server.ts` `POST /api/packages` accepts an
  arbitrary `source` string with no validation and no allowlist (global scope
  forwards to the Manager). `replacePackagesV1Schema` validates shape, not
  provenance. No allowlist/hidden-packages mechanism exists anywhere in pi-hub.
- Runner environment: `runnerEnvFor` (`packages/manager/src/supervisor.ts`)
  spawns the Runner with the full configured env; any MCP stdio child spawned by
  the adapter inside the Runner inherits that environment by default.

## Security findings (facts from the adapter's own docs)

- **No sandboxing.** `inheritEnv` defaults to `true` ("preserves full
  host-environment inheritance" for stdio children); setting it `false` "is not
  an empty environment or an OS sandbox"; the docs state the adapter "does not
  provide complete multi-agent or helper-process isolation".
- **Secrets.** OAuth tokens go to the OS keychain (`@napi-rs/keyring`) by
  default, encrypted file opt-in, legacy plaintext `tokens.json` import path.
  Static API keys live **plaintext** in the JSON config (`headers`, `env`);
  `!command` indirection can fetch them from a helper command. No secret-manager
  integration.
- **Transcript exposure.** MCP tool results (direct or via the `mcp` proxy tool)
  are returned as `content` to the model — server-controlled text enters the
  transcript (prompt-injection surface). MCP **prompts** become slash commands,
  **elicitation** lets a server ask the user questions, and **sampling** lets a
  server request a model completion through Pi's configured model and
  credentials.
- **Settings mutation.** The adapter edits Pi's own `settings.json`
  (`extensions: ["-builtin:mcp"]`); pi-hub's readers only look at `packages`,
  so this change is invisible to pi-hub and survives package removal.

## Risk register

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Unsupported SDK floor → silent misbehaviour (hidden/deferred tools, unregister no-ops), `/mcp` command collisions | High | Do not install before upgrading pi-hub to pi >= 0.99; then pin the exact adapter version |
| R2 | Adapter adds MCP config surfaces no admin can control (install by URL, `/setup`, imports, 9-tier precedence) | High | Only viable shape is host-managed embedding (`createHostManagedMcpAdapter({ servers })` — isolated config, no file discovery, approval broker) and never as a user-addable package |
| R3 | Every stdio MCP child inherits the Runner's full env (callback token, provider keys, `PIHUB_*`) | High | Mandate `inheritEnv: false` per server, keep `!command` helpers out, run MCP children as a separate restricted user/process |
| R4 | Prompt injection / capability escalation (sampling uses Pi's model+key; elicitation; prompts-as-slash-commands) | High | Disable sampling/elicitation/UI apps, `approveTools: true`, treat every server's output as untrusted content |
| R5 | No per-server allowlist; project-server trust only covers project-scoped files and is skipped headless unless `projectServers:"allow"`; `--mcp-project-servers allow` bypass exists | High | Build the allowlist in pi-hub (validate `source` on the Runner `POST /api/packages` and the Manager routes) — not in the adapter |
| R6 | Plaintext static keys in JSON config; keychain likely absent in containers | Med-High | Encrypted-file mode or short-lived `!command` tokens; never commit `.mcp.json`; keep secrets in the Manager's env custody |
| R7 | Supply chain: 13 deps incl. a native binary and a beta dep; 4.8 MB; TypeScript executed at runtime | Med | Pin exact version + integrity hash; mirror internally; no version ranges |
| R8 | Version drift (1.4M/mo, fast majors, "Unreleased" changelog entries) | Med | Pinned upgrades on a controlled cadence |
| R9 | Adapter mutates Pi `settings.json` invisibly to pi-hub | Med | Snapshot/restore `settings.json` around installs; extend pi-hub's readers if adopted |
| R10 | Install requires Runner restart; refused while a turn is live (existing pi-hub behaviour) | Low | Keep as is |

## Conditional path (if MCP is pursued later)

1. Upgrade `@earendil-works/pi-coding-agent` to >= 0.99 in both workspaces
   (separate, verified unit — it is a runtime-wide upgrade, not a package).
2. Embed host-managed MCP (`createHostManagedMcpAdapter`) instead of installing
   the package into agents: pi-hub owns the server list, users cannot add
   servers, approval broker on, sampling/elicitation/UI off.
3. Build the package allowlist in pi-hub first (close `POST /api/packages`
   provenance hole) — independent of MCP, valuable on its own.
4. Custody: no plaintext static keys in agent-visible config; per-server
   `inheritEnv: false`; dedicated OS user for MCP children.
5. Container smoke tests per S6 before any default: spawn a dummy stdio server,
   confirm tool call round-trip, confirm no secret appears in transcripts/feeds.

## Honest limits of this research

- Metadata and source facts come from the published pages and `main` branch on
  the research date; the package evolves quickly (major 7.0.0 within the last
  month).
- The adapter's ~90 source files were not audited for malicious code; imports,
  manifest, docs and dependency list were inspected.
- No installation or execution was performed (read-only unit): the failing-peer
  install behaviour and the loadability of the embedding APIs on 0.80.3 remain
  unverified.
