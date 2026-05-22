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
      { ts: '2026-05-20T00:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 },
      { ts: '2026-05-23T11:00:00Z', tool: 'codegraph_search', project: '/a', durMs: 10, respBytes: 100 },
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
