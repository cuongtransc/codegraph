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
