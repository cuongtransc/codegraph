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
