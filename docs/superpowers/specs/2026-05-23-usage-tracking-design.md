# Codegraph Usage Tracking — Design

**Date:** 2026-05-23
**Status:** Approved (brainstorm complete; pending implementation plan)
**Owner:** @cuongtransc

## Problem

Codegraph has no visibility into its own usage. Users who install it
cannot answer "am I actually getting value out of this?" — there is no
equivalent of `rtk gain`. The MCP server runs in a subprocess driven by
agents (Claude Code, Cursor, Codex, opencode); calls arrive over stdio
and disappear after they return. The only existing observability is
`codegraph status`, which reports static facts about the *index*, not
about call patterns.

## Goals

1. Let the user run a single command and see how much they have used
   codegraph — per tool, per project, over time.
2. Honest measurement only. No speculative "savings vs grep" numbers.
3. Local-first. No data leaves the machine.
4. Zero impact on tool-call latency or correctness. Logging failures
   must never break a call.

## Non-Goals

- Cross-machine sync / hosted analytics.
- Per-row token estimation beyond a byte count. Different agents use
  different tokenizers; users can convert bytes themselves if they care.
- Speculative "you saved N tokens vs grep" figures. The counterfactual
  is unknowable from inside the MCP server.
- Exposing usage data over MCP. Agents do not need to introspect their
  own behavior during a session — that is user-facing terrain only.

## User Experience

### Primary command

```bash
codegraph gain
```

```
Codegraph usage — last 30 days
  Total calls:        842
  Total response:     2.4 MB (~600k tokens at 4 B/token)
  Avg duration:       18ms

  Top tools (all, ordered by call count):
    codegraph_search    412  (1.1 MB returned)
    codegraph_context   188  (820 KB returned)
    codegraph_callers    98  (240 KB returned)
    codegraph_explore    72  (180 KB returned)
    codegraph_node       40  (45 KB returned)
    codegraph_impact     22  (38 KB returned)
    codegraph_files      10  (18 KB returned)

  Top projects (top 10 by call count):
    codegraph           520  (1.5 MB)
    bmf-medusa-demo     220  (640 KB)
    other-project       102  (260 KB)

Tracking: ON  •  Mode: minimal  •  ~/.codegraph/usage.jsonl (1.2 MB)
```

Flags:

| Flag              | Effect                                                      |
| ----------------- | ----------------------------------------------------------- |
| `--since <dur>`   | Restrict to last duration. Format: `<int><unit>` where unit ∈ `m,h,d,w` (e.g. `30m`, `24h`, `7d`, `2w`). Default `30d`. Invalid input exits non-zero with a parser error. |
| `--project <path>`| Restrict to one project. Case-sensitive substring match against the logged project path. Use `--project-exact` for exact match. |
| `--project-exact <path>` | Like `--project` but requires exact equality with the logged root. |
| `--tool <name>`   | Restrict to one tool (e.g. `codegraph_search`).              |
| `--json`          | Emit aggregated JSON instead of the formatted table.         |

### Control subcommands

```bash
codegraph usage status            # Show config + file size
codegraph usage enable [--verbose] # Enable; --verbose also logs query args
codegraph usage disable            # Stop recording (does not delete history)
codegraph usage clear              # Truncate usage.jsonl (confirm prompt)
```

### Env-var override

`CODEGRAPH_USAGE=0` disables recording for the current process even if
the config file says enabled. Useful for CI, scripted runs, and
debugging. The env var always wins over the config file.

## Architecture

### Instrumentation point

Every MCP tool call passes through one method:

- `ToolHandler.execute(toolName, args)` at `src/mcp/tools.ts:624`

`execute()` already wraps its dispatch in `try/catch` and never throws —
errors come back as `ToolResult` with `isError: true` (see `ToolResult`
interface at `src/mcp/tools.ts:252-258`). The recorder is built around
this contract.

We wrap this method with a recorder. The recorder:

1. Captures `startTime` and `toolName`.
2. Calls the original `execute()`.
3. After the call returns, computes `durMs` and `respBytes` from the
   result. If `result.isError === true`, sets `error: true` on the row.
4. Fire-and-forgets a row to `~/.codegraph/usage.jsonl`. "Fire-and-forget"
   means the recorder kicks off the write but does not `await` it before
   returning the tool result to the caller. The write is allowed to
   complete in the background event-loop turn. Unawaited writes can be
   lost if the MCP server process is killed mid-flight (agent shutdown,
   signal) — acceptable trade-off for usage data.
5. Wraps the entire recording path in `try/catch` and swallows any
   exception from the recorder itself, so a recorder bug can never break
   a tool call.

If a recorder-internal exception occurs *before* `execute()` is invoked
(e.g. config read throws), the recorder still runs the wrapped call and
returns its result. The instrumentation never alters return values.

### Project-field resolution

The recorder logs `project` as the **resolved CodeGraph root**, not the
raw `args.projectPath`. Rationale: callers can pass subdirectory paths,
or omit the param entirely (falling back to `defaultProjectHint ?? cwd`,
see `src/mcp/tools.ts:545-547`). Without canonicalization, the same
logical project can appear under multiple `project` values, breaking
per-project aggregation.

Resolution rules, applied in the recorder *after* `execute()` returns:

1. If `args.projectPath` is provided, call `findNearestCodeGraphRoot()`
   on it; on success log the resolved root, on failure log the raw
   `args.projectPath` and mark `error: true` (since the tool call itself
   will have errored with "not initialized").
2. If `args.projectPath` is absent, log `defaultProjectHint ?? cwd`
   (raw) — `ToolHandler` exposes `defaultProjectHint` to the recorder
   via a getter.
3. For tools that don't require a project (only `codegraph_status` in
   practice, when called against a missing index), log whatever rule 1
   or 2 produced even if it doesn't resolve to a real root. Aggregator
   surfaces these under a separate "unresolved" bucket in `--json`
   output.

### Config & env-var lookup

Config (`enabled`, `mode`) and the `CODEGRAPH_USAGE` env var are read
**once at MCP server init** and cached in-process. Per-call config
reads would add an `fs.readFile` to every tool call, violating the
zero-latency-impact goal.

Consequence: `codegraph usage enable|disable|--verbose` does not take
effect for already-running MCP servers. Document this in the command's
help text and in the README. Restarting the agent (which restarts the
MCP server subprocess) picks up the new config.

`CODEGRAPH_USAGE=0` is also snapshotted at init and is intended for
ad-hoc scripted runs of the CLI / one-shot MCP processes, not for
toggling a long-lived server.

### New modules

```
src/usage/
  recorder.ts      # writes one JSONL row per call (append-only)
  aggregator.ts    # reads JSONL, computes rollups for `codegraph gain`
  config.ts        # reads/writes ~/.codegraph/config.json, honors env var
  paths.ts         # canonicalizes ~/.codegraph/* paths cross-platform
```

### CLI surface

Two new subcommands in `src/bin/codegraph.ts`:

- `gain` — reads aggregator output, prints table or JSON.
- `usage <enable|disable|status|clear>` — manages config + file.

## Data Model

### File: `~/.codegraph/usage.jsonl`

Append-only JSONL. One JSON object per line. Each row:

```json
{
  "ts": "2026-05-23T03:24:11.412Z",
  "tool": "codegraph_search",
  "project": "/Users/connor/Dev/PCT/01-AI/02-Tools/codegraph",
  "durMs": 12,
  "respBytes": 4821
}
```

Verbose-mode addition (only when `usage enable --verbose` is set):

```json
{
  "ts": "...", "tool": "...", "project": "...", "durMs": 12, "respBytes": 4821,
  "args": { "query": "ExtractionOrchestrator", "kind": "class" }
}
```

Size budget: ~120 B/row minimal, ~250 B/row verbose. 10k calls ≈
1.2 MB minimal. No compaction or rotation in v1; a future
`codegraph gain --compact` can roll old rows into daily aggregates if
the file ever crosses a meaningful threshold.

### File: `~/.codegraph/config.json`

```json
{
  "usage": {
    "enabled": true,
    "mode": "minimal"
  }
}
```

- `enabled`: boolean. Default `true` after `codegraph install`.
- `mode`: `"minimal"` (default) or `"verbose"`.

The file is created lazily by the recorder on first write if missing;
`codegraph install` writes it explicitly so the install-time message
matches reality.

## Failure Modes & Edge Cases

| Scenario                              | Behavior                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `~/.codegraph/` does not exist        | Recorder creates it on first write. Failure → swallow, log to stderr once per process.    |
| Disk full / EACCES                    | Swallow error. Emit one stderr warning per process. Subsequent writes silently no-op.     |
| Corrupt JSONL row mid-file            | Aggregator skips it. Count of skipped rows surfaced under `codegraph gain --json` only.   |
| Concurrent writes from N processes    | Within one MCP server, stdio requests are serial — no intra-process contention. Cross-process collisions (multiple MCP servers, or CLI runs concurrent with a server) rely on the kernel's `O_APPEND` semantics on Linux/Darwin, which keep small (<1 KB) writes from interleaving in practice. Rows are well below that threshold. |
| Tool call returns `isError: true`     | Recorder writes row with `error: true` and the actual `respBytes` from the error result. Return value passed through unchanged. |
| Recorder throws                       | Caught and swallowed inside the decorator. Tool call result is unaffected.                |
| MCP server killed mid-write           | Unawaited write may not flush. One row lost. Acceptable for usage data; no flush-on-exit hook in v1. |
| Clock skew between calls              | Aggregator uses string sort on ISO timestamps; no math on inter-call gaps.                |
| User runs `codegraph usage clear` while a call is in flight | Truncate is atomic; in-flight write may land in a fresh file. Acceptable. |
| `args.projectPath` doesn't resolve to a CodeGraph root | Recorder logs the raw path and marks `error: true`. Aggregator buckets these under "unresolved" in `--json` output. |

## Privacy Posture

- **Default mode (`minimal`)** never logs query strings, symbol names,
  or response content. Only structural metadata: timestamp, tool name,
  project path, duration, response byte count.
- **Verbose mode** logs `args` verbatim. Opt-in only via explicit
  `codegraph usage enable --verbose`. Documented as "this file contains
  the names of things you searched for; treat it like shell history."
- **Project path is always logged** in both modes. This is your own
  filesystem; the trade-off (per-project breakdown vs total privacy)
  favors usefulness. A future `--anonymize-projects` flag is possible
  if anyone asks.
- **Nothing ever leaves the machine.** No network calls from the usage
  subsystem. Ever. This is a hard rule, not a default.

## Install-Time Consent

`codegraph install` adds one line to its existing output, printed
**once at the end** of the install flow regardless of how many agent
targets were selected:

```
✓ MCP server registered
✓ CLAUDE.md written
✓ Usage tracking enabled — ~/.codegraph/usage.jsonl
  (disable with 'codegraph usage disable' or env CODEGRAPH_USAGE=0)
```

This makes the on-by-default behavior visible at the moment of consent
(install), without requiring a separate prompt. Users who object can
disable in one command.

### New global directory

`~/.codegraph/` is a new global directory introduced by this feature.
It is distinct from per-project `.codegraph/` index directories. Today
codegraph only writes to per-project locations and to agent-managed
config dirs (`~/.claude.json`, `~/.codex/`, etc.); this is the first
artifact codegraph itself owns under `~/`. Call it out in the README
section so users aren't surprised.

### Interaction with `codegraph uninstall`

`codegraph uninstall` removes the MCP server registration from each
agent's config. It does **not** touch `~/.codegraph/usage.jsonl` or
`~/.codegraph/config.json` — that's the user's historical data. The
uninstall output mentions both files and points at `codegraph usage
clear` if the user wants to remove the history before reinstalling.

## Tests

New test files under `__tests__/`:

- `usage-recorder.test.ts`
  - Recorder writes one row per call.
  - Recorder snapshots config + env var at init; later config writes
    do NOT affect an already-constructed recorder.
  - Recorder honors `enabled=false` snapshot.
  - Recorder honors `CODEGRAPH_USAGE=0` snapshot (overrides config).
  - Recorder swallows write errors (mock `fs.appendFile` to throw).
  - Recorder logs `error: true` when `execute()` returns
    `{ isError: true }` (not when it throws — `execute()` doesn't
    throw, see `src/mcp/tools.ts:648-650`).
  - Recorder still records when the recorder's own pre-call logic
    throws (defensive `try/catch` around the whole decorator).
  - Recorder is non-blocking — `execute` resolves before the
    `fs.appendFile` promise resolves (verified by spying with a
    deferred mock).
  - `project` field equals the resolved CodeGraph root when
    `args.projectPath` points at a subdirectory under a real index.
  - `project` field equals the raw input when resolution fails, and
    the row carries `error: true`.

- `usage-aggregator.test.ts`
  - Aggregates by tool, by project, by day.
  - Filters: `--since`, `--project` (substring), `--project-exact`,
    `--tool`.
  - Handles malformed rows (skip + count).
  - Handles missing/empty file (returns empty rollup, not error).
  - Unresolved-project rows surface in `--json` under a separate
    bucket, not mixed into the top-projects table.

- `usage-cli.test.ts`
  - `codegraph gain` formatted-table output matches snapshot. Time is
    pinned via `vi.useFakeTimers` so the "last 30 days" window
    doesn't drift the snapshot.
  - `codegraph gain --json` shape is stable.
  - `codegraph gain --since` parser rejects malformed input
    (non-zero exit, error message on stderr).
  - `codegraph usage enable --verbose` round-trips through config.
  - `codegraph usage` enable/disable output mentions that running MCP
    servers must be restarted to pick up the change.
  - `codegraph usage clear` truncates and prompts (`--yes` skips
    prompt).

- Smoke addition to existing MCP test:
  - `tools.execute()` returns identical results when recorder is
    enabled vs disabled.

## Documentation & Rollout

- **README.md** — new section `## Usage Tracking` covering: what it
  records, where it lives (call out `~/.codegraph/` as a new global
  directory distinct from per-project `.codegraph/`), how to disable,
  verbose mode trade-off, and the MCP-restart caveat for
  enable/disable.
- **CHANGELOG.md** — under next version:
  - `### Added`
    - `codegraph gain` command shows per-tool and per-project usage
      from a local `~/.codegraph/usage.jsonl` log.
    - `codegraph usage` subcommand (enable/disable/status/clear) plus
      `CODEGRAPH_USAGE=0` env-var override.
- **`codegraph install` output** — see Install-Time Consent above.
- **No update needed to** `src/mcp/server-instructions.ts`,
  `src/installer/instructions-template.ts`, or
  `.cursor/rules/codegraph.mdc` — usage tracking is user-facing CLI,
  not agent-facing guidance.

## Out of Scope (Explicit YAGNI)

- Cross-machine sync, hosted dashboards, anonymous-stats opt-in.
- Token estimation that does not equal byte count. (Document
  "~4 B/token rough" once; do not implement per-tokenizer math.)
- Speculative "savings vs grep" or "savings vs Read" numbers.
- An MCP tool that lets agents query usage data. CLI is the only
  consumer.
- Log rotation. v1 ships without it. If `usage.jsonl` ever exceeds a
  threshold that matters, add `codegraph gain --compact` then.
- Per-call `args` capture in minimal mode, ever.

## Open Questions

None at design time. All forks resolved during brainstorm:

- Signal: response sizes (proxy for value delivered).
- Storage: global (`~/.codegraph/usage.jsonl`).
- Privacy: minimal by default, opt-in verbose.
- Consent: on by default, surfaced at install.

## Revision History

- **2026-05-23 (initial):** Approved after brainstorm.
- **2026-05-23 (post-review):** Corrected error-path semantics
  (`execute()` does not throw — recorder inspects `result.isError`).
  Added explicit project-field resolution rules. Specified that
  config/env are snapshotted at MCP-server init, not read per call.
  Clarified `fs.appendFile` atomicity wording. Added handling for
  unresolved project paths, `codegraph uninstall` interaction, and
  the new global `~/.codegraph/` directory. Tightened test plan
  (time-pinned snapshots, `--since` parser, exact-vs-substring
  project filter). Documented one-row loss risk on mid-write kill.
