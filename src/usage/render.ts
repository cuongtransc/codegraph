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
