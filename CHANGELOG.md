# Changelog

## Unreleased

### Changed

- Default models now use the Gemini 4 family offered by Antigravity CLI 1.5.15: `gemini-4-carbon-high` (quality), `gemini-4-hydrogen-medium` (balanced) and `gemini-4-hydrogen-low` (fast). The previous quality default, `gemini-3.1-pro-high`, is no longer in the CLI's model list. Override with `ANTIGRAVITY_DEFAULT_MODEL`, `ANTIGRAVITY_BALANCED_MODEL` and `ANTIGRAVITY_FAST_MODEL`.

### Documentation

- Documented `ANTIGRAVITY_MAX_BUFFERED_STDOUT_BYTES` and added worker-terminal guidance to the orchestrator skill.

## 0.3.0 — 2026-09-18

Source: GitHub merge commit `b88033289a820ce1f50e5d10823df57f5a518892` from PR #1.

### Added

- Optional, formatted Windows Command Prompt viewers for individual workers, team agents, coordinators, continuations, and retry attempts.
- Live rendering of response deltas, tool and subagent state, and relevant team messages.
- Completion metadata for status, token usage, duration, attempt, conversation, and run identifiers.
- A two-minute completed-window timer. Any key cancels the timer and leaves the viewer open.
- UTF-8 incremental decoding, including stream chunks split inside multibyte characters.
- Regression coverage for the viewer, streamed result handling, terminal sidecars, failure details, and open-input auto-close behavior.

### Reliability changes

- Terminal completion sidecars are stored in a dedicated `terminals` directory and excluded from run-ledger scans.
- The scheduler incrementally collects the final `stream-json` result, even when progress output exceeds its bounded fallback buffer.
- Failed viewers display scheduler or provider errors after partial response text has streamed.
- Auto-close pauses stdin so an open input handle cannot keep the viewer process alive.
- Edit workers that report success without a captured, non-empty patch are marked failed. Denied action names are included when available, and invalid empty-edit results are not retried.

### How it works

The scheduler starts the Antigravity CLI with `stream-json` output and continues to own execution, persistence, retries, cancellation, and patch capture. On Windows, when `ANTIGRAVITY_WORKER_TERMINALS=on`, it also launches a separate read-only viewer. The viewer tails the worker's persisted streams and team ledger; closing it has no effect on the worker. At completion, the scheduler writes a small terminal record that gives the viewer its authoritative final status.

The local installation enables the viewer. Use `doctor` in a new Codex task and check `worker_terminals.enabled` to verify that the active scheduler received the setting.

### Validation

- Repository CI passed on Windows and Linux with Node.js 22 and 24.
- Full local mock suite passed on Windows.
- A synthetic 35.7 MB progress stream retained its final successful result.
- Filtered and unfiltered run listings ignored terminal sidecars.
- A completed viewer exited with stdin held open.
- A failed viewer displayed its scheduler error after partial streamed output.
