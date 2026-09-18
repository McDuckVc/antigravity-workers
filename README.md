# Antigravity Workers

Supervised Google Antigravity workers for Codex, exposed through a local Model Context Protocol (MCP) server.

Delegate bounded code analysis, review, isolated edits, multimodal research, and native image generation. Codex owns requirements, review, validation, and integration. Workers return reports and patches for inspection.

## Features

- Individual analysis, review, and edit workers with queued execution and retries.
- Read-only teams with distinct roles, reviewer and coordinator stages, correction rounds, messaging, and live dashboards.
- Isolated Git worktrees for edit jobs, with patch inspection before `apply_run`.
- Explicitly scoped media inputs copied into per-run workspaces; native image generation and editing.
- Persistent run and team ledgers, cancellation, continuation, and recovery after interruption.
- One scheduler per state directory, shared across multiple MCP clients.
- Optional per-worker live Command Prompt windows on Windows.
- No npm runtime dependencies.

## Requirements

- Node.js 20 or newer and Git on `PATH`.
- A separately installed and authenticated Antigravity CLI (`agy`) for real worker jobs. CLI access, model availability, provider terms, and usage limits are separate from this project.
- Codex or another MCP client supporting local standard-input/output servers.

Windows and Linux are the supported targets for this release. macOS is not currently supported: an interrupted scheduler can leave a stale local socket that prevents restart.

The test suites use a mock CLI and require no provider account. This repository contains the integration; it does not redistribute the Antigravity CLI or grant access to Google services.

## Quick start

```sh
git clone https://github.com/McDuckVc/antigravity-workers.git
cd antigravity-workers
npm test
```

Register the MCP server using your checkout's **absolute path**:

```sh
codex mcp add antigravity-workers -- node "/absolute/path/antigravity-workers/server/index.mjs"
```

If `agy` is installed somewhere other than its default location:

```sh
codex mcp add antigravity-workers --env ANTIGRAVITY_AGY_PATH="/absolute/path/to/agy" -- node "/absolute/path/antigravity-workers/server/index.mjs"
```

On Windows, quote paths containing spaces and use your actual executable paths. The default CLI location on Windows is `%LOCALAPPDATA%/agy/bin/agy.exe`; on other platforms the server resolves `agy` from `PATH`.

Restart your Codex session after registering the server. Ask it to run `doctor` and `list_models`, then give a bounded assignment, for example:

> Use Antigravity Workers to review the parser in this repository. Report issues with file references. Do not modify files.

### Live worker Command Prompt windows (Windows)

Set `ANTIGRAVITY_WORKER_TERMINALS=on` in the MCP server environment to open one read-only Command Prompt window for each running worker, including team members, coordinators, continuations, and retry attempts. Each viewer renders Antigravity's structured response deltas, tool and subagent activity, and incoming coordinator or peer messages as they arrive. Completed windows use a black-and-green `color 0A` theme with a framed agent-information header, the response text, and a separate run-metadata frame containing status, token usage, duration, and identifiers. Team windows continue to receive relevant messages after their worker finishes, and the scheduler continues to parse and persist the original streams normally.

Closing a viewer window does not cancel its worker. Use `cancel_run` or `cancel_team` for cancellation. After the response and metadata are displayed, completed viewers start a two-minute auto-close timer. Press any key during that timer to cancel it and keep the window open until you close it; relevant team messages continue streaming while it remains open. The feature is Windows-only and opt-in so headless sessions, CI, and automations do not open desktop windows.

For a direct MCP registration, add the environment variable when registering the server:

```sh
codex mcp add antigravity-workers --env ANTIGRAVITY_WORKER_TERMINALS=on -- node "C:\absolute\path\antigravity-workers\server\index.mjs"
```

Run `doctor` after restarting Codex and check `worker_terminals.enabled` to confirm the setting reached the scheduler owner.

For the orchestration guidance, copy `skills/antigravity-orchestrator` to your personal Codex skills directory (`~/.codex/skills/`) or use this repository as a plugin through your configured marketplace. Direct MCP registration installs the tools; adding the skill supplies the workflow instructions.

### Plugin packaging

The repository includes a portable `plugin.json` and `mcp.json`, plus `.codex-plugin/plugin.json` and `.mcp.json` compatibility files. The portable MCP configuration uses `${PLUGIN_ROOT}` to resolve the installed server location. A marketplace host must support local stdio servers. See the [official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for marketplace setup. Publication on GitHub does not install the plugin into the official directory.

## Tools

| Purpose | Tools |
| --- | --- |
| Diagnostics | `doctor`, `list_models`, `get_account` |
| Code workers | `start_analysis`, `start_review`, `start_edit` |
| Run lifecycle | `get_run`, `list_runs`, `continue_run`, `cancel_run`, `apply_run` |
| Teams | `start_team`, `get_team`, `list_teams`, `team_dashboard`, `message_agent`, `cancel_team`, `resume_team` |
| Media | `start_media_analysis`, `start_image_generation`, `start_image_edit`, `get_media_run`, `list_artifacts` |

Read the tool schemas exposed by the server for complete inputs. Prefer `model_policy` (`quality`, `balanced`, or `fast`) and check `list_models` for account availability.

## Configuration

Set these variables in the MCP client's server environment:

| Variable | Default / purpose |
| --- | --- |
| `ANTIGRAVITY_AGY_PATH` | Override the CLI executable path. |
| `ANTIGRAVITY_STATE_DIR` | Windows: `%LOCALAPPDATA%/CodexAntigravityWorkers`; other platforms: `~/.codex/antigravity-workers`. |
| `ANTIGRAVITY_MAX_WORKERS` | `auto`; derived from CPU and memory, capped at 16. Explicit values: 1–32. |
| `ANTIGRAVITY_MAX_TEAM_AGENTS` | Server default 32; bundled plugin configuration 64. |
| `ANTIGRAVITY_DEFAULT_MODEL` | `gemini-3.1-pro-high` |
| `ANTIGRAVITY_BALANCED_MODEL` | `gemini-3.8-flash-medium` |
| `ANTIGRAVITY_FAST_MODEL` | `gemini-3.8-flash-low` |
| `ANTIGRAVITY_WORKER_TERMINALS` | `off`; set to `on` on Windows to open a formatted Command Prompt result viewer for every running worker. |
| `ANTIGRAVITY_MAX_MEDIA_FILE_MB` | 250 MB per input file. |
| `ANTIGRAVITY_MAX_MEDIA_TOTAL_MB` | 1024 MB across a request's inputs. |
| `ANTIGRAVITY_MAX_INLINE_ARTIFACT_MB` | 12 MB for inline artifacts. |
| `ANTIGRAVITY_BRAIN_DIR` | `~/.gemini/antigravity-cli/brain`; used to discover generated artifacts. |

Model IDs are configurable defaults, not guarantees of provider availability. Matching model suffixes determine compatible effort.

## Data and execution boundaries

This is a local orchestration tool, not a security sandbox. Workers run with the permissions enforced by Antigravity and the host. Give them only authorized projects and inputs. Code and media jobs may send selected content to the configured provider.

The state directory can contain prompts, responses, logs, worktrees, artifacts, and local runtime authentication material. Keep it outside public repositories. `get_account` returns the active account identifier only when explicitly requested; it does not expose OAuth tokens.

Edit workers require a Git repository. A CLI success result is accepted only when patch capture also produces code changes; denied actions or an empty patch are reported as a failed run and are not automatically retried. Inspect the patch and relevant tests before calling `apply_run`; read-only teams never apply edits. See [SECURITY.md](SECURITY.md).

## Development and validation

```sh
npm test
```

The mock suites exercise the MCP protocol, queuing and retries, worker lifecycles, teams, scoped media, image artifacts, patch handling, shared runtime ownership, and restart behavior. CI runs these tests on Windows and Linux with Node.js 22 and 24.

The optional `npm run test:live` invokes your authenticated Antigravity CLI and consumes provider usage. It is excluded from CI. Additional media/image smoke checks are opt-in through `ANTIGRAVITY_MEDIA_SMOKE_FILE` and `ANTIGRAVITY_IMAGE_SMOKE=1`.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).

Independent community project; not affiliated with or endorsed by Google or OpenAI. Product names belong to their respective owners.
