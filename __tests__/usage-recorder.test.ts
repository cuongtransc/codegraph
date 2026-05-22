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
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    const spy = vi.spyOn(fs.promises, 'appendFile').mockReturnValue(writePromise as Promise<void>);
    const wrapped = rec.wrap(async () => okResult);

    const callPromise = wrapped('codegraph_search', { query: 'x' });
    const out = await Promise.race([callPromise, new Promise((r) => setTimeout(() => r('still-blocked'), 50))]);
    expect(out).toBe(okResult);

    resolveWrite!();
    await rec.flush();
    mkdirSpy.mockRestore();
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
