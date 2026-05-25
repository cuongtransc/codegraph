# Codegraph Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local-only usage tracking for codegraph MCP tool calls, surfaced via a new `codegraph gain` command (analogous to `rtk gain`).

**Architecture:** A small `src/usage/` module records one JSONL row per MCP tool call to `~/.codegraph/usage.jsonl`. The recorder decorates `ToolHandler.execute()` at one point. Config (`enabled`/`mode`) and `CODEGRAPH_USAGE` env var are snapshotted at MCP-server init. CLI subcommands `codegraph gain` and `codegraph usage` read/aggregate/manage.

**Tech Stack:** TypeScript, Node `fs.promises`, vitest for tests, commander for CLI, clack for installer prompts.

**Spec:** [`docs/superpowers/specs/2026-05-23-usage-tracking-design.md`](../specs/2026-05-23-usage-tracking-design.md)

---

## File Map

**New files:**
- `src/usage/paths.ts` — resolves `~/.codegraph/{usage.jsonl,config.json}` cross-platform.
- `src/usage/config.ts` — reads/writes config file, computes effective state from config + env var, snapshot API.
- `src/usage/recorder.ts` — `UsageRecorder` class: decorates `ToolHandler.execute`, fire-and-forget JSONL append.
- `src/usage/aggregator.ts` — reads JSONL, rolls up by tool/project/day, applies filters.
- `src/usage/render.ts` — formats a `Rollup` into the human-readable table.
- `__tests__/usage-paths.test.ts`
- `__tests__/usage-config.test.ts`
- `__tests__/usage-recorder.test.ts`
- `__tests__/usage-aggregator.test.ts`
- `__tests__/usage-cli.test.ts`

**Modified files:**
- `src/mcp/tools.ts` — expose `defaultProjectHint` via a getter (recorder needs it for project-field resolution).
- `src/mcp/index.ts` — instantiate `UsageRecorder` after `ToolHandler`, route tool calls through the wrapped function, flush on shutdown.
- `src/bin/codegraph.ts` — register `gain` and `usage` subcommands.
- `src/installer/index.ts` — call `ensureConfig()` at end of install; print one-liner about tracking.
- `README.md` — add `## Usage Tracking` section.
- `CHANGELOG.md` — add entry under next version.

**Responsibility split:**
- `paths.ts` is the *only* place that knows where files live (testable via env-var override).
- `config.ts` is the *only* place that reads/writes config; it produces a `UsageConfigSnapshot` for the recorder.
- `recorder.ts` only knows about the snapshot it was constructed with; it never reads config or env at runtime.
- `aggregator.ts` only reads files; never writes.

---

## Task 1: Paths module

**Files:**
- Create: `src/usage/paths.ts`
- Test: `__tests__/usage-paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/usage-paths.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { usageDir, usageLogPath, configPath } from '../src/usage/paths';

describe('usage/paths', () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.CODEGRAPH_HOME;
    delete process.env.CODEGRAPH_HOME;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CODEGRAPH_HOME;
    else process.env.CODEGRAPH_HOME = prev;
  });

  it('defaults to ~/.codegraph/', () => {
    expect(usageDir()).toBe(path.join(os.homedir(), '.codegraph'));
    expect(usageLogPath()).toBe(path.join(os.homedir(), '.codegraph', 'usage.jsonl'));
    expect(configPath()).toBe(path.join(os.homedir(), '.codegraph', 'config.json'));
  });

  it('honors CODEGRAPH_HOME for tests', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-home-'));
    process.env.CODEGRAPH_HOME = tmp;
    expect(usageDir()).toBe(tmp);
    expect(usageLogPath()).toBe(path.join(tmp, 'usage.jsonl'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-paths.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/usage/paths.ts
import * as os from 'os';
import * as path from 'path';

export function usageDir(): string {
  return process.env.CODEGRAPH_HOME || path.join(os.homedir(), '.codegraph');
}

export function usageLogPath(): string {
  return path.join(usageDir(), 'usage.jsonl');
}

export function configPath(): string {
  return path.join(usageDir(), 'config.json');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run __tests__/usage-paths.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/usage/paths.ts __tests__/usage-paths.test.ts
git commit -m "feat(usage): add paths module for ~/.codegraph/ resolution"
```

---

## Task 2: Config module

**Files:**
- Create: `src/usage/config.ts`
- Test: `__tests__/usage-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/usage-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadConfig,
  saveConfig,
  ensureConfig,
  snapshotEffective,
  type UsageConfig,
} from '../src/usage/config';
import { configPath } from '../src/usage/paths';

describe('usage/config', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevHome = process.env.CODEGRAPH_HOME;
    prevEnv = process.env.CODEGRAPH_USAGE;
    delete process.env.CODEGRAPH_USAGE;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfg-'));
    process.env.CODEGRAPH_HOME = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.CODEGRAPH_HOME; else process.env.CODEGRAPH_HOME = prevHome;
    if (prevEnv === undefined) delete process.env.CODEGRAPH_USAGE; else process.env.CODEGRAPH_USAGE = prevEnv;
  });

  it('loadConfig returns defaults when file missing', () => {
    const cfg = loadConfig();
    expect(cfg).toEqual({ usage: { enabled: true, mode: 'minimal' } });
  });

  it('saveConfig and loadConfig round-trip', () => {
    const cfg: UsageConfig = { usage: { enabled: false, mode: 'verbose' } };
    saveConfig(cfg);
    expect(fs.existsSync(configPath())).toBe(true);
    expect(loadConfig()).toEqual(cfg);
  });

  it('ensureConfig creates default file if missing, leaves existing untouched', () => {
    ensureConfig();
    const first = loadConfig();
    expect(first.usage.enabled).toBe(true);

    saveConfig({ usage: { enabled: false, mode: 'minimal' } });
    ensureConfig();
    expect(loadConfig().usage.enabled).toBe(false);
  });

  it('snapshotEffective honors CODEGRAPH_USAGE=0 over config', () => {
    saveConfig({ usage: { enabled: true, mode: 'verbose' } });
    process.env.CODEGRAPH_USAGE = '0';
    const snap = snapshotEffective();
    expect(snap.enabled).toBe(false);
    expect(snap.mode).toBe('verbose'); // mode is still reported
    expect(snap.source).toBe('env');
  });

  it('snapshotEffective falls back to config when env unset', () => {
    saveConfig({ usage: { enabled: true, mode: 'minimal' } });
    const snap = snapshotEffective();
    expect(snap.enabled).toBe(true);
    expect(snap.source).toBe('config');
  });

  it('malformed config file returns defaults (does not throw)', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '{ not json');
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().usage.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-config.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/usage/config.ts
import * as fs from 'fs';
import { configPath, usageDir } from './paths';

export interface UsageConfig {
  usage: {
    enabled: boolean;
    mode: 'minimal' | 'verbose';
  };
}

export interface UsageConfigSnapshot {
  enabled: boolean;
  mode: 'minimal' | 'verbose';
  /** Where the `enabled` value came from. */
  source: 'env' | 'config' | 'default';
}

const DEFAULT_CONFIG: UsageConfig = {
  usage: { enabled: true, mode: 'minimal' },
};

export function loadConfig(): UsageConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<UsageConfig>;
    return {
      usage: {
        enabled: parsed.usage?.enabled ?? DEFAULT_CONFIG.usage.enabled,
        mode: parsed.usage?.mode === 'verbose' ? 'verbose' : 'minimal',
      },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg: UsageConfig): void {
  const dir = usageDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

export function ensureConfig(): UsageConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  return loadConfig();
}

export function snapshotEffective(): UsageConfigSnapshot {
  const cfg = loadConfig();
  const env = process.env.CODEGRAPH_USAGE;
  if (env === '0' || env === 'false' || env === 'off') {
    return { enabled: false, mode: cfg.usage.mode, source: 'env' };
  }
  if (env === '1' || env === 'true' || env === 'on') {
    return { enabled: true, mode: cfg.usage.mode, source: 'env' };
  }
  return { enabled: cfg.usage.enabled, mode: cfg.usage.mode, source: 'config' };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run __tests__/usage-config.test.ts
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/usage/config.ts __tests__/usage-config.test.ts
git commit -m "feat(usage): add config module with env-var override snapshot"
```

---

## Task 3: Recorder module (decorator + JSONL append)

**Files:**
- Create: `src/usage/recorder.ts`
- Test: `__tests__/usage-recorder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/usage-recorder.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageRecorder } from '../src/usage/recorder';
import { usageLogPath } from '../src/usage/paths';
import type { ToolResult } from '../src/mcp/tools';

function readRows(p: string): Record<string, unknown>[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('UsageRecorder', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.CODEGRAPH_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rec-'));
    process.env.CODEGRAPH_HOME = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.CODEGRAPH_HOME;
    else process.env.CODEGRAPH_HOME = prevHome;
  });

  const okResult: ToolResult = { content: [{ type: 'text', text: 'hello' }] };
  const errResult: ToolResult = { content: [{ type: 'text', text: 'oops' }], isError: true };

  it('writes one row per call with required fields', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' });
    const wrapped = rec.wrap(async (_name, _args) => okResult);
    await wrapped('codegraph_search', { query: 'foo', projectPath: home });
    await rec.flush();

    const rows = readRows(usageLogPath());
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tool).toBe('codegraph_search');
    expect(row.project).toBe(home);
    expect(typeof row.durMs).toBe('number');
    expect(row.respBytes).toBe(Buffer.byteLength('hello', 'utf8'));
    expect(typeof row.ts).toBe('string');
    expect(row.args).toBeUndefined();
    expect(row.error).toBeUndefined();
  });

  it('records error:true when ToolResult.isError is set', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' });
    const wrapped = rec.wrap(async () => errResult);
    await wrapped('codegraph_search', { query: 'x', projectPath: home });
    await rec.flush();

    const rows = readRows(usageLogPath());
    expect(rows[0].error).toBe(true);
  });

  it('verbose mode includes args (excluding projectPath)', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'verbose', source: 'config' });
    const wrapped = rec.wrap(async () => okResult);
    await wrapped('codegraph_search', { query: 'foo', kind: 'class', projectPath: home });
    await rec.flush();

    const rows = readRows(usageLogPath());
    expect(rows[0].args).toEqual({ query: 'foo', kind: 'class' });
  });

  it('does not record when disabled', async () => {
    const rec = new UsageRecorder({ enabled: false, mode: 'minimal', source: 'env' });
    const wrapped = rec.wrap(async () => okResult);
    await wrapped('codegraph_search', { query: 'x', projectPath: home });
    await rec.flush();

    expect(fs.existsSync(usageLogPath())).toBe(false);
  });

  it('passes through the wrapped result unchanged', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' });
    const wrapped = rec.wrap(async () => okResult);
    const out = await wrapped('codegraph_search', { query: 'x', projectPath: home });
    expect(out).toBe(okResult);
  });

  it('swallows write errors (does not throw)', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' });
    const spy = vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('disk full'));
    const wrapped = rec.wrap(async () => okResult);
    await expect(wrapped('codegraph_search', { query: 'x' })).resolves.toBe(okResult);
    await rec.flush();
    spy.mockRestore();
  });

  it('does not await fs.appendFile before returning result', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' });
    let resolveWrite: (() => void) | null = null;
    const writePromise = new Promise<void>((r) => { resolveWrite = r; });
    const spy = vi.spyOn(fs.promises, 'appendFile').mockReturnValue(writePromise as Promise<void>);
    const wrapped = rec.wrap(async () => okResult);

    const callPromise = wrapped('codegraph_search', { query: 'x' });
    const out = await Promise.race([callPromise, new Promise((r) => setTimeout(() => r('still-blocked'), 50))]);
    expect(out).toBe(okResult); // not 'still-blocked'

    resolveWrite!();
    await rec.flush();
    spy.mockRestore();
  });

  it('falls back to cwd when projectPath is absent', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' }, {
      getDefaultProjectHint: () => undefined,
    });
    const wrapped = rec.wrap(async () => okResult);
    await wrapped('codegraph_status', {});
    await rec.flush();

    const rows = readRows(usageLogPath());
    expect(rows[0].project).toBe(process.cwd());
  });

  it('uses defaultProjectHint when projectPath is absent', async () => {
    const rec = new UsageRecorder({ enabled: true, mode: 'minimal', source: 'config' }, {
      getDefaultProjectHint: () => '/hint/path',
    });
    const wrapped = rec.wrap(async () => okResult);
    await wrapped('codegraph_status', {});
    await rec.flush();

    const rows = readRows(usageLogPath());
    expect(rows[0].project).toBe('/hint/path');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-recorder.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/usage/recorder.ts
import * as fs from 'fs';
import type { ToolResult } from '../mcp/tools';
import { usageDir, usageLogPath } from './paths';
import type { UsageConfigSnapshot } from './config';

export interface RecorderHooks {
  /** Recorder asks this for the MCP server's default project hint when args.projectPath is missing. */
  getDefaultProjectHint?: () => string | undefined;
}

type ExecuteFn = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;

interface UsageRow {
  ts: string;
  tool: string;
  project: string;
  durMs: number;
  respBytes: number;
  error?: true;
  args?: Record<string, unknown>;
}

export class UsageRecorder {
  private pending: Promise<void>[] = [];
  private warnedOnce = false;

  constructor(
    private readonly snapshot: UsageConfigSnapshot,
    private readonly hooks: RecorderHooks = {},
  ) {}

  /**
   * Decorate an execute function with recording. The returned function has
   * identical semantics to the original (same return value, same exceptions),
   * but additionally fires off a JSONL append in the background after the
   * wrapped call resolves.
   */
  wrap(execute: ExecuteFn): ExecuteFn {
    return async (toolName, args) => {
      if (!this.snapshot.enabled) return execute(toolName, args);

      const startTime = Date.now();
      const result = await execute(toolName, args);

      try {
        const row = this.buildRow(toolName, args, result, startTime);
        const p = this.scheduleWrite(row);
        this.pending.push(p);
      } catch {
        // Recorder bug must never break a tool call.
      }
      return result;
    };
  }

  /** Wait for all queued background writes to complete. Used by tests and graceful shutdown. */
  async flush(): Promise<void> {
    const inFlight = this.pending.splice(0);
    await Promise.allSettled(inFlight);
  }

  private buildRow(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    startTime: number,
  ): UsageRow {
    const respText = result.content.map((c) => c.text).join('');
    const row: UsageRow = {
      ts: new Date(startTime).toISOString(),
      tool: toolName,
      project: this.resolveProject(args),
      durMs: Date.now() - startTime,
      respBytes: Buffer.byteLength(respText, 'utf8'),
    };
    if (result.isError) row.error = true;
    if (this.snapshot.mode === 'verbose') {
      const { projectPath: _omit, ...rest } = args;
      if (Object.keys(rest).length > 0) row.args = rest;
    }
    return row;
  }

  private resolveProject(args: Record<string, unknown>): string {
    const raw = typeof args.projectPath === 'string' ? args.projectPath : undefined;
    if (raw) return raw;
    return this.hooks.getDefaultProjectHint?.() ?? process.cwd();
  }

  private scheduleWrite(row: UsageRow): Promise<void> {
    return (async () => {
      try {
        await fs.promises.mkdir(usageDir(), { recursive: true });
        await fs.promises.appendFile(usageLogPath(), JSON.stringify(row) + '\n');
      } catch (err) {
        if (!this.warnedOnce) {
          this.warnedOnce = true;
          process.stderr.write(
            `[codegraph usage] failed to write usage log: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    })();
  }
}
```

> Note: project-field resolution to the *CodeGraph root* (per spec) requires the recorder to know about `findNearestCodeGraphRoot`. Doing that resolution synchronously in the recorder duplicates work `ToolHandler.execute` already did. We log the **raw** path the caller passed (or hint/cwd) and let the aggregator decide how to group. If a future need arises for canonicalized project paths, add it there, not here. This keeps the recorder zero-dependency on the graph layer. (Flagged for spec-author review.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run __tests__/usage-recorder.test.ts
```
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/usage/recorder.ts __tests__/usage-recorder.test.ts
git commit -m "feat(usage): add UsageRecorder decorator with fire-and-forget JSONL"
```

---

## Task 4: Wire recorder into MCP server

**Files:**
- Modify: `src/mcp/tools.ts` (add `getDefaultProjectHint()` getter)
- Modify: `src/mcp/index.ts` (instantiate recorder, decorate execute, flush on shutdown)
- Test: `__tests__/usage-recorder.test.ts` (add MCP-integration assertion)

- [ ] **Step 1: Add the failing integration test**

Append to `__tests__/usage-recorder.test.ts`:

```ts
import { ToolHandler } from '../src/mcp/tools';

describe('UsageRecorder × ToolHandler', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.CODEGRAPH_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rec-int-'));
    process.env.CODEGRAPH_HOME = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.CODEGRAPH_HOME;
    else process.env.CODEGRAPH_HOME = prevHome;
  });

  it('decorated execute returns identical result and records a row', async () => {
    const handler = new ToolHandler(null);
    const rec = new UsageRecorder(
      { enabled: true, mode: 'minimal', source: 'config' },
      { getDefaultProjectHint: () => handler.getDefaultProjectHint() },
    );
    const original = handler.execute.bind(handler);
    const wrapped = rec.wrap(original);

    // codegraph_status with no project loaded returns an error result, not throws
    const result = await wrapped('codegraph_status', {});
    expect(result).toHaveProperty('content');
    await rec.flush();

    const rows = fs.readFileSync(usageLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0].tool).toBe('codegraph_status');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-recorder.test.ts -t "ToolHandler"
```
Expected: FAIL — `handler.getDefaultProjectHint is not a function`.

- [ ] **Step 3: Add the getter in `src/mcp/tools.ts`**

Find the `ToolHandler` class (around line 470-500) and add this method near `setDefaultProjectHint`:

```ts
  /** Exposed for instrumentation (usage recorder). Do not use for routing. */
  getDefaultProjectHint(): string | undefined {
    return this.defaultProjectHint;
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run __tests__/usage-recorder.test.ts -t "ToolHandler"
```
Expected: 1 passed.

- [ ] **Step 5: Wire into MCP server**

In `src/mcp/index.ts`, add imports near the top:

```ts
import { UsageRecorder } from '../usage/recorder';
import { snapshotEffective } from '../usage/config';
```

Add private fields to the `MCPServer` class:

```ts
private usageRecorder: UsageRecorder;
private recordedExecute: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
```

In the constructor, after `this.toolHandler = new ToolHandler(null);` (around line 103):

```ts
this.usageRecorder = new UsageRecorder(snapshotEffective(), {
  getDefaultProjectHint: () => this.toolHandler.getDefaultProjectHint(),
});
this.recordedExecute = this.usageRecorder.wrap(
  this.toolHandler.execute.bind(this.toolHandler),
);
```

Find every call site of `this.toolHandler.execute(` in this file and replace with `this.recordedExecute(`. There should be one in the `tools/call` handler.

In `stop()` (or the cleanup path that runs on SIGINT/SIGTERM/stdin-close), add:

```ts
await this.usageRecorder.flush();
```

Place the flush before `this.toolHandler.closeAll()` and before the process exit, so background writes complete.

- [ ] **Step 6: Verify nothing regressed in MCP tests**

```bash
npx vitest run __tests__/mcp-initialize.test.ts __tests__/mcp-roots.test.ts
```
Expected: all existing MCP tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools.ts src/mcp/index.ts __tests__/usage-recorder.test.ts
git commit -m "feat(usage): wire UsageRecorder into MCP server execute path"
```

---

## Task 5: Aggregator module

**Files:**
- Create: `src/usage/aggregator.ts`
- Test: `__tests__/usage-aggregator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/usage-aggregator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aggregate, parseSince } from '../src/usage/aggregator';
import { usageLogPath, usageDir } from '../src/usage/paths';

function seed(rows: Record<string, unknown>[]): void {
  fs.mkdirSync(usageDir(), { recursive: true });
  fs.writeFileSync(usageLogPath(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('usage/aggregator', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.CODEGRAPH_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-agg-'));
    process.env.CODEGRAPH_HOME = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.CODEGRAPH_HOME;
    else process.env.CODEGRAPH_HOME = prevHome;
  });

  it('returns empty rollup when file missing', () => {
    const r = aggregate({});
    expect(r.totalCalls).toBe(0);
    expect(r.byTool).toEqual([]);
    expect(r.byProject).toEqual([]);
  });

  it('counts calls and bytes, sorts tools/projects by call count desc', () => {
    seed([
      { ts: '2026-05-23T01:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 },
      { ts: '2026-05-23T02:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 20, respBytes: 200 },
      { ts: '2026-05-23T03:00:00Z', tool: 'codegraph_context', project: '/b', durMs: 30, respBytes: 300 },
    ]);
    const r = aggregate({});
    expect(r.totalCalls).toBe(3);
    expect(r.totalBytes).toBe(600);
    expect(r.byTool[0]).toMatchObject({ tool: 'codegraph_search', calls: 2, bytes: 300 });
    expect(r.byTool[1]).toMatchObject({ tool: 'codegraph_context', calls: 1, bytes: 300 });
    expect(r.byProject[0]).toMatchObject({ project: '/a', calls: 2 });
  });

  it('filters by --tool', () => {
    seed([
      { ts: '2026-05-23T01:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 },
      { ts: '2026-05-23T02:00:00Z', tool: 'codegraph_context', project: '/a', durMs: 20, respBytes: 200 },
    ]);
    const r = aggregate({ tool: 'codegraph_search' });
    expect(r.totalCalls).toBe(1);
  });

  it('filters by --project (substring)', () => {
    seed([
      { ts: '2026-05-23T01:00:00Z', tool: 'codegraph_search', project: '/home/user/codegraph', durMs: 10, respBytes: 100 },
      { ts: '2026-05-23T02:00:00Z', tool: 'codegraph_search', project: '/home/user/other', durMs: 20, respBytes: 200 },
    ]);
    expect(aggregate({ project: 'codegraph' }).totalCalls).toBe(1);
    expect(aggregate({ project: 'user' }).totalCalls).toBe(2);
  });

  it('filters by --project-exact', () => {
    seed([
      { ts: '2026-05-23T01:00:00Z', tool: 'codegraph_search', project: '/a/b', durMs: 10, respBytes: 100 },
      { ts: '2026-05-23T02:00:00Z', tool: 'codegraph_search', project: '/a/b/c', durMs: 20, respBytes: 200 },
    ]);
    expect(aggregate({ projectExact: '/a/b' }).totalCalls).toBe(1);
  });

  it('filters by --since (relative duration from now)', () => {
    const now = new Date('2026-05-23T12:00:00Z');
    seed([
      { ts: '2026-05-20T00:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 }, // 3.5d ago
      { ts: '2026-05-23T11:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 }, // 1h ago
    ]);
    expect(aggregate({ since: '24h', now }).totalCalls).toBe(1);
    expect(aggregate({ since: '7d', now }).totalCalls).toBe(2);
  });

  it('skips malformed rows and counts them', () => {
    fs.mkdirSync(usageDir(), { recursive: true });
    fs.writeFileSync(usageLogPath(),
      JSON.stringify({ ts: '2026-05-23T01:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 }) + '\n' +
      '{not json}\n' +
      JSON.stringify({ ts: '2026-05-23T02:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 }) + '\n');
    const r = aggregate({});
    expect(r.totalCalls).toBe(2);
    expect(r.skipped).toBe(1);
  });

  it('parseSince accepts m/h/d/w', () => {
    expect(parseSince('30m')).toBe(30 * 60 * 1000);
    expect(parseSince('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseSince('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseSince('2w')).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('parseSince rejects malformed input', () => {
    expect(() => parseSince('30')).toThrow();
    expect(() => parseSince('xx')).toThrow();
    expect(() => parseSince('1y')).toThrow();
    expect(() => parseSince('-1h')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-aggregator.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/usage/aggregator.ts
import * as fs from 'fs';
import { usageLogPath } from './paths';

export interface UsageRow {
  ts: string;
  tool: string;
  project: string;
  durMs: number;
  respBytes: number;
  error?: boolean;
  args?: Record<string, unknown>;
}

export interface AggregateOptions {
  since?: string;
  tool?: string;
  project?: string;
  projectExact?: string;
  /** Override "now" for tests. */
  now?: Date;
}

export interface ToolRollup { tool: string; calls: number; bytes: number; }
export interface ProjectRollup { project: string; calls: number; bytes: number; }

export interface Rollup {
  totalCalls: number;
  totalBytes: number;
  avgDurMs: number;
  byTool: ToolRollup[];
  byProject: ProjectRollup[];
  windowStart: string | null;
  windowEnd: string | null;
  skipped: number;
}

const SINCE_RE = /^([1-9]\d*)([mhdw])$/;

export function parseSince(input: string): number {
  const m = SINCE_RE.exec(input);
  if (!m) throw new Error(`Invalid --since "${input}". Expected <int><m|h|d|w> (e.g. 30m, 24h, 7d, 2w).`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'm': return n * 60_000;
    case 'h': return n * 3600_000;
    case 'd': return n * 86400_000;
    case 'w': return n * 7 * 86400_000;
  }
  throw new Error('unreachable');
}

export function aggregate(opts: AggregateOptions): Rollup {
  const path = usageLogPath();
  if (!fs.existsSync(path)) return emptyRollup();

  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
  const now = opts.now ?? new Date();
  const sinceMs = opts.since ? parseSince(opts.since) : null;
  const cutoff = sinceMs !== null ? new Date(now.getTime() - sinceMs).toISOString() : null;

  const byTool = new Map<string, ToolRollup>();
  const byProject = new Map<string, ProjectRollup>();
  let totalCalls = 0;
  let totalBytes = 0;
  let totalDur = 0;
  let skipped = 0;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  for (const line of lines) {
    let row: UsageRow;
    try { row = JSON.parse(line) as UsageRow; }
    catch { skipped++; continue; }
    if (typeof row.tool !== 'string' || typeof row.project !== 'string' || typeof row.ts !== 'string') {
      skipped++; continue;
    }
    if (cutoff && row.ts < cutoff) continue;
    if (opts.tool && row.tool !== opts.tool) continue;
    if (opts.projectExact && row.project !== opts.projectExact) continue;
    if (opts.project && !row.project.includes(opts.project)) continue;

    totalCalls++;
    totalBytes += row.respBytes || 0;
    totalDur += row.durMs || 0;
    windowStart = windowStart === null || row.ts < windowStart ? row.ts : windowStart;
    windowEnd = windowEnd === null || row.ts > windowEnd ? row.ts : windowEnd;

    const t = byTool.get(row.tool) ?? { tool: row.tool, calls: 0, bytes: 0 };
    t.calls++; t.bytes += row.respBytes || 0;
    byTool.set(row.tool, t);

    const p = byProject.get(row.project) ?? { project: row.project, calls: 0, bytes: 0 };
    p.calls++; p.bytes += row.respBytes || 0;
    byProject.set(row.project, p);
  }

  return {
    totalCalls,
    totalBytes,
    avgDurMs: totalCalls ? Math.round(totalDur / totalCalls) : 0,
    byTool: [...byTool.values()].sort((a, b) => b.calls - a.calls),
    byProject: [...byProject.values()].sort((a, b) => b.calls - a.calls),
    windowStart,
    windowEnd,
    skipped,
  };
}

function emptyRollup(): Rollup {
  return {
    totalCalls: 0, totalBytes: 0, avgDurMs: 0,
    byTool: [], byProject: [], windowStart: null, windowEnd: null, skipped: 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run __tests__/usage-aggregator.test.ts
```
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/usage/aggregator.ts __tests__/usage-aggregator.test.ts
git commit -m "feat(usage): add aggregator with tool/project/time-window rollups"
```

---

## Task 6: `codegraph gain` CLI command

**Files:**
- Create: `src/usage/render.ts`
- Modify: `src/bin/codegraph.ts`
- Test: `__tests__/usage-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/usage-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.join(__dirname, '..', 'dist', 'bin', 'codegraph.js');

interface CliResult { stdout: string; stderr: string; code: number; }

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync('node', [BIN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

describe('codegraph gain', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-'));
    fs.mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prints empty-state message when no log exists', () => {
    const r = runCli(['gain'], { CODEGRAPH_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No usage data yet/);
  });

  it('prints aggregated table when log has rows', () => {
    fs.writeFileSync(path.join(home, 'usage.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), tool: 'codegraph_search', project: '/x', durMs: 10, respBytes: 100 }) + '\n' +
      JSON.stringify({ ts: new Date().toISOString(), tool: 'codegraph_context', project: '/x', durMs: 20, respBytes: 200 }) + '\n');
    const r = runCli(['gain'], { CODEGRAPH_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Total calls:\s+2/);
    expect(r.stdout).toMatch(/codegraph_search/);
    expect(r.stdout).toMatch(/codegraph_context/);
  });

  it('--json emits stable JSON shape', () => {
    fs.writeFileSync(path.join(home, 'usage.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), tool: 'codegraph_search', project: '/x', durMs: 10, respBytes: 100 }) + '\n');
    const r = runCli(['gain', '--json'], { CODEGRAPH_HOME: home });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.totalCalls).toBe(1);
    expect(parsed.byTool[0].tool).toBe('codegraph_search');
  });

  it('--since rejects malformed input with non-zero exit', () => {
    const r = runCli(['gain', '--since', '30'], { CODEGRAPH_HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Invalid --since/);
  });
});
```

- [ ] **Step 2: Build the project first (CLI test runs `dist/`)**

```bash
npm run build
```
Expected: succeeds.

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-cli.test.ts -t "gain"
```
Expected: FAIL — `Unknown command 'gain'`.

- [ ] **Step 4: Create the renderer**

```ts
// src/usage/render.ts
import type { Rollup } from './aggregator';
import type { UsageConfigSnapshot } from './config';

interface RenderOpts {
  snap: UsageConfigSnapshot;
  since: string;
  logSize: number;
  logPath: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderGain(r: Rollup, opts: RenderOpts): string {
  if (r.totalCalls === 0) {
    return `No usage data yet for window "${opts.since}".\n` +
      `Tracking: ${opts.snap.enabled ? 'ON' : 'OFF'} • ${opts.logPath}\n`;
  }
  const tokens = Math.round(r.totalBytes / 4);
  const lines: string[] = [];
  lines.push(`Codegraph usage — last ${opts.since}`);
  lines.push(`  Total calls:        ${r.totalCalls}`);
  lines.push(`  Total response:     ${fmtBytes(r.totalBytes)} (~${tokens.toLocaleString()} tokens at 4 B/token)`);
  lines.push(`  Avg duration:       ${r.avgDurMs}ms`);
  lines.push('');
  lines.push('  Top tools (all, ordered by call count):');
  for (const t of r.byTool) {
    lines.push(`    ${t.tool.padEnd(20)} ${String(t.calls).padStart(4)}  (${fmtBytes(t.bytes)} returned)`);
  }
  lines.push('');
  lines.push('  Top projects (top 10 by call count):');
  for (const p of r.byProject.slice(0, 10)) {
    const label = p.project.length > 40 ? '…' + p.project.slice(-39) : p.project;
    lines.push(`    ${label.padEnd(40)} ${String(p.calls).padStart(4)}  (${fmtBytes(p.bytes)})`);
  }
  lines.push('');
  lines.push(`Tracking: ${opts.snap.enabled ? 'ON' : 'OFF'}  •  Mode: ${opts.snap.mode}  •  ${opts.logPath} (${fmtBytes(opts.logSize)})`);
  if (r.skipped) lines.push(`  (skipped ${r.skipped} malformed row${r.skipped === 1 ? '' : 's'})`);
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 5: Add the `gain` subcommand to `src/bin/codegraph.ts`**

Add this block near the other `program.command(...)` blocks (e.g. after the `affected` command, before `install`):

```ts
/**
 * codegraph gain — local usage analytics
 */
program
  .command('gain')
  .description('Show codegraph usage analytics from ~/.codegraph/usage.jsonl')
  .option('--since <dur>', 'Restrict to last duration (e.g. 30m, 24h, 7d, 2w)', '30d')
  .option('--tool <name>', 'Restrict to one tool name')
  .option('--project <substr>', 'Restrict to project paths containing this substring')
  .option('--project-exact <path>', 'Restrict to exact project path match')
  .option('--json', 'Emit JSON instead of formatted table')
  .action(async (opts: {
    since?: string;
    tool?: string;
    project?: string;
    projectExact?: string;
    json?: boolean;
  }) => {
    const { aggregate } = await import('../usage/aggregator');
    const { snapshotEffective } = await import('../usage/config');
    const { usageLogPath } = await import('../usage/paths');
    const { renderGain } = await import('../usage/render');
    const fs = await import('fs');

    let rollup;
    try {
      rollup = aggregate({
        since: opts.since,
        tool: opts.tool,
        project: opts.project,
        projectExact: opts.projectExact,
      });
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(rollup, null, 2) + '\n');
      return;
    }

    const snap = snapshotEffective();
    const logSize = fs.existsSync(usageLogPath()) ? fs.statSync(usageLogPath()).size : 0;
    process.stdout.write(renderGain(rollup, { snap, since: opts.since ?? '30d', logSize, logPath: usageLogPath() }));
  });
```

- [ ] **Step 6: Rebuild and run test to verify it passes**

```bash
npm run build && npx vitest run __tests__/usage-cli.test.ts -t "gain"
```
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add src/bin/codegraph.ts src/usage/render.ts __tests__/usage-cli.test.ts
git commit -m "feat(usage): add 'codegraph gain' CLI command"
```

---

## Task 7: `codegraph usage` control subcommand

**Files:**
- Modify: `src/bin/codegraph.ts`
- Test: `__tests__/usage-cli.test.ts` (add new describe block)

- [ ] **Step 1: Append failing tests**

Append to `__tests__/usage-cli.test.ts`:

```ts
describe('codegraph usage', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-usage-'));
    fs.mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('status prints current config and file size', () => {
    const r = runCli(['usage', 'status'], { CODEGRAPH_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Tracking:/);
    expect(r.stdout).toMatch(/Mode:/);
  });

  it('enable then disable round-trip through config file', () => {
    runCli(['usage', 'disable'], { CODEGRAPH_HOME: home });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).usage.enabled).toBe(false);

    runCli(['usage', 'enable'], { CODEGRAPH_HOME: home });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).usage.enabled).toBe(true);
  });

  it('enable --verbose sets mode to verbose', () => {
    runCli(['usage', 'enable', '--verbose'], { CODEGRAPH_HOME: home });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(cfg.usage.mode).toBe('verbose');
  });

  it('enable/disable output mentions restart-for-running-servers', () => {
    const r = runCli(['usage', 'enable'], { CODEGRAPH_HOME: home });
    expect(r.stdout).toMatch(/restart|new MCP/i);
  });

  it('clear truncates usage.jsonl with --yes', () => {
    fs.writeFileSync(path.join(home, 'usage.jsonl'), '{"ts":"x","tool":"y","project":"z","durMs":1,"respBytes":1}\n');
    const r = runCli(['usage', 'clear', '--yes'], { CODEGRAPH_HOME: home });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(home, 'usage.jsonl'), 'utf8')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run __tests__/usage-cli.test.ts -t "codegraph usage"
```
Expected: FAIL — `Unknown command 'usage'`.

- [ ] **Step 3: Add the `usage` subcommand to `src/bin/codegraph.ts`**

Add near the `gain` command:

```ts
/**
 * codegraph usage — manage local usage tracking
 */
const usageCmd = program
  .command('usage')
  .description('Manage codegraph local usage tracking (enable/disable/status/clear)');

usageCmd
  .command('status')
  .description('Show usage tracking config and log file size')
  .action(async () => {
    const fs = await import('fs');
    const { snapshotEffective } = await import('../usage/config');
    const { usageLogPath } = await import('../usage/paths');
    const snap = snapshotEffective();
    const p = usageLogPath();
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    process.stdout.write(
      `Tracking: ${snap.enabled ? 'ON' : 'OFF'} (source: ${snap.source})\n` +
      `Mode:     ${snap.mode}\n` +
      `Log:      ${p} (${size} bytes)\n`,
    );
  });

usageCmd
  .command('enable')
  .description('Enable usage tracking')
  .option('--verbose', 'Also record query/arg values (privacy trade-off)')
  .action(async (opts: { verbose?: boolean }) => {
    const { loadConfig, saveConfig } = await import('../usage/config');
    const cfg = loadConfig();
    cfg.usage.enabled = true;
    if (opts.verbose) cfg.usage.mode = 'verbose';
    saveConfig(cfg);
    process.stdout.write(
      `Usage tracking enabled (mode: ${cfg.usage.mode}).\n` +
      'Note: running MCP server processes must be restarted to pick up the change.\n',
    );
  });

usageCmd
  .command('disable')
  .description('Disable usage tracking (history preserved)')
  .action(async () => {
    const { loadConfig, saveConfig } = await import('../usage/config');
    const cfg = loadConfig();
    cfg.usage.enabled = false;
    saveConfig(cfg);
    process.stdout.write(
      'Usage tracking disabled. History preserved at ~/.codegraph/usage.jsonl.\n' +
      'Note: running MCP server processes must be restarted to pick up the change.\n',
    );
  });

usageCmd
  .command('clear')
  .description('Truncate ~/.codegraph/usage.jsonl (history is lost)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (opts: { yes?: boolean }) => {
    const fs = await import('fs');
    const { usageLogPath } = await import('../usage/paths');
    const p = usageLogPath();
    if (!fs.existsSync(p)) {
      process.stdout.write('No usage log to clear.\n');
      return;
    }
    if (!opts.yes) {
      process.stderr.write('Refusing to clear without --yes. Pass --yes to confirm.\n');
      process.exit(1);
    }
    fs.writeFileSync(p, '');
    process.stdout.write(`Cleared ${p}.\n`);
  });
```

- [ ] **Step 4: Rebuild and run test to verify it passes**

```bash
npm run build && npx vitest run __tests__/usage-cli.test.ts -t "codegraph usage"
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/bin/codegraph.ts __tests__/usage-cli.test.ts
git commit -m "feat(usage): add 'codegraph usage' enable/disable/status/clear"
```

---

## Task 8: Installer integration

**Files:**
- Modify: `src/installer/index.ts`
- Test: existing installer tests (smoke check)

- [ ] **Step 1: Find the install flow's success section**

```bash
grep -n "clack.log.success\|outro\|Install complete" src/installer/index.ts | head -10
```

Locate where the installer prints its final success messages (after each agent target is written). The new line should run **once** at the end regardless of how many targets were chosen.

- [ ] **Step 2: Add usage-tracking init + one-liner**

Near the top of `src/installer/index.ts`, add imports:

```ts
import { ensureConfig } from '../usage/config';
import { usageLogPath } from '../usage/paths';
```

At the end of the install flow (after the existing success messages, before the `outro`), add:

```ts
const cfg = ensureConfig();
const tracking = cfg.usage.enabled ? 'enabled' : 'disabled';
clack.log.success(
  `Usage tracking ${tracking} — ${usageLogPath()}\n` +
  `  (manage with 'codegraph usage' or env CODEGRAPH_USAGE=0)`,
);
```

(Match the existing import style — the file already uses `import * as clack from '@clack/prompts'` or similar; reuse that namespace.)

- [ ] **Step 3: Run installer tests to verify no regression**

```bash
npx vitest run __tests__/installer.test.ts __tests__/installer-targets.test.ts
```
Expected: all tests pass.

- [ ] **Step 4: Manual smoke**

```bash
npm run build
CODEGRAPH_HOME=/tmp/cg-smoke-$$ node dist/bin/codegraph.js install --target none --location global --yes 2>&1 | tail -10
ls /tmp/cg-smoke-$$
rm -rf /tmp/cg-smoke-*
```
Expected: output mentions "Usage tracking enabled"; `/tmp/cg-smoke-$$/config.json` exists with default contents.

- [ ] **Step 5: Commit**

```bash
git add src/installer/index.ts
git commit -m "feat(usage): write default config and announce tracking on install"
```

---

## Task 9: Smoke regression in existing MCP test

**Files:**
- Modify: `__tests__/mcp-initialize.test.ts`

- [ ] **Step 1: Open the existing test file and pick an `it()` to extend**

```bash
grep -n "it(" __tests__/mcp-initialize.test.ts | head -10
```

Choose an existing test that already drives a tool call. Add an assertion that with `process.env.CODEGRAPH_USAGE = '1'` (and `CODEGRAPH_HOME` pointed at a tempdir created in `beforeEach`), the tool call result shape is unchanged.

```ts
// Inside the chosen test:
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-rec-'));
process.env.CODEGRAPH_HOME = home;
process.env.CODEGRAPH_USAGE = '1';
try {
  // ... existing tool-call assertions ...
} finally {
  delete process.env.CODEGRAPH_USAGE;
  fs.rmSync(home, { recursive: true, force: true });
}
```

The key assertion is that the tool call still returns a `ToolResult` shape with `content[]`, identical to the unrecorded path.

- [ ] **Step 2: Run the test**

```bash
npx vitest run __tests__/mcp-initialize.test.ts
```
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add __tests__/mcp-initialize.test.ts
git commit -m "test(usage): smoke-check MCP tool call works with recorder enabled"
```

---

## Task 10: Documentation + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a `## Usage Tracking` section to `README.md`**

Place it after the existing install/usage docs but before the API reference. Content:

````markdown
## Usage Tracking

Codegraph records one line per MCP tool call to `~/.codegraph/usage.jsonl`
so you can see how much you actually use it. See it with:

```bash
codegraph gain
```

What's recorded (minimal mode, default):
- timestamp, tool name, project path, duration, response byte count.

What's **not** recorded by default: your queries, symbol names, or
response content. To opt into recording arguments too:

```bash
codegraph usage enable --verbose
```

To turn tracking off entirely:

```bash
codegraph usage disable      # persistent
CODEGRAPH_USAGE=0 ...        # one-process override
```

The log lives in a new global directory `~/.codegraph/` — distinct from
the per-project `.codegraph/` index directory. Nothing in this subsystem
ever sends data off your machine.

`enable`/`disable` only takes effect for **new** MCP server processes.
Restart your agent (Claude Code, Cursor, etc.) to pick up a change.
````

- [ ] **Step 2: Add CHANGELOG entry**

At the top of `CHANGELOG.md` (under the intro, above the previous version), add a new `## [X.Y.Z] - 2026-05-23` block using whatever version is being bumped. Under `### Added`:

```markdown
- `codegraph gain` shows per-tool and per-project usage from a local
  `~/.codegraph/usage.jsonl` log. Filters: `--since`, `--tool`,
  `--project`, `--project-exact`. JSON output via `--json`.
- `codegraph usage` subcommand (enable/disable/status/clear) with a
  `--verbose` mode that opts into recording argument values, and a
  `CODEGRAPH_USAGE=0` env-var override.
- Install flow now writes `~/.codegraph/config.json` and announces
  usage tracking in its output.
```

Add the link reference at the bottom of the file.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(usage): document tracking, gain command, and CHANGELOG entry"
```

---

## Self-Review (already performed)

**1. Spec coverage:**
- ✓ Primary command `codegraph gain` → Tasks 5, 6.
- ✓ Control subcommands (status/enable/disable/clear) → Task 7.
- ✓ `CODEGRAPH_USAGE` env-var override → Task 2.
- ✓ Instrumentation at `ToolHandler.execute` → Task 4.
- ✓ Snapshot config at MCP init (no per-call read) → Tasks 3, 4.
- ✓ Project field resolution (logs raw path; aggregator does the grouping) → Task 3 + note explaining deliberate deviation from spec's "resolve to root" suggestion.
- ✓ Data model (JSONL row shape) → Task 3.
- ✓ Privacy: minimal default, verbose opt-in → Tasks 3, 7.
- ✓ Install-time consent line → Task 8.
- ✓ New global `~/.codegraph/` directory → Task 1.
- ✓ Failure modes (write errors, malformed rows, killed mid-write) → Tasks 3, 5.
- ✓ Tests (recorder, aggregator, CLI, smoke MCP) → Tasks 3, 5, 6, 7, 9.
- ✓ Docs (README + CHANGELOG) → Task 10.

**Deviation from spec:** Spec section "Project-field resolution" requested calling `findNearestCodeGraphRoot()` from inside the recorder. The plan logs the raw path instead and leaves grouping to the aggregator. Rationale: the recorder stays decoupled from the graph layer and avoids re-doing work `ToolHandler.execute` already performed. The aggregator's substring filter handles the common case ("show me usage for this repo") without needing canonicalization. Flagged for spec-author review — if you want strict spec compliance, Task 3 grows by ~10 lines and the recorder imports `findNearestCodeGraphRoot` from `../index`.

**2. Placeholder scan:** None remaining. Every step has the actual code/command. Task 8 step 1 uses `grep` to locate a line because the exact line number depends on installer-flow refactors; that's explicit guidance, not a placeholder.

**3. Type consistency:**
- `UsageConfigSnapshot` shape (`enabled`, `mode`, `source`) used identically in Tasks 2, 3, 6, 7.
- `Rollup` interface defined in Task 5 used unchanged in Task 6 renderer.
- `UsageRecorder.wrap(execute)` signature matches `ToolHandler.execute` signature exactly: `(toolName: string, args: Record<string, unknown>) => Promise<ToolResult>`.
- `RecorderHooks.getDefaultProjectHint` signature matches `ToolHandler.getDefaultProjectHint` added in Task 4.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Best for a 10-task plan touching this many surfaces.

**2. Inline Execution** — execute tasks in this session, batch with checkpoints.

Which approach?
