/**
 * MCP `initialize` handshake regression tests.
 *
 * Issue #172: on slow filesystems (Docker Desktop VirtioFS on macOS, WSL2),
 * the MCP server was blocking the initialize response on CodeGraph.open() and
 * Parser.init() (web-tree-sitter WASM bootstrap), which could take longer than
 * Claude Code's ~30s handshake timeout. The child process stayed alive and
 * had received the request, but never sent a response, so tools never
 * appeared in the client. The fix sends the initialize response before
 * kicking off the heavy init in the background. These tests guard the
 * contract that initialize is fast regardless of how much work init does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { UsageRecorder } from '../src/usage/recorder';
import { snapshotEffective } from '../src/usage/config';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

function sendInitialize(child: ChildProcessWithoutNullStreams, projectPath: string) {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri: `file://${projectPath}`,
    },
  });
  child.stdin.write(msg + '\n');
}

/**
 * Collect stdout lines and stderr text from the child, tagging each piece
 * with a monotonic sequence number. Lets us assert ordering between the
 * JSON-RPC response (stdout) and side-effect logs (stderr).
 */
function tagStreams(child: ChildProcessWithoutNullStreams) {
  const events: Array<{ seq: number; stream: 'stdout' | 'stderr'; text: string }> = [];
  let seq = 0;
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stdout', text: line });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      events.push({ seq: seq++, stream: 'stderr', text: line });
    }
  });
  return events;
}

function waitFor<T>(
  events: ReadonlyArray<{ seq: number; stream: string; text: string }>,
  predicate: (e: { seq: number; stream: string; text: string }) => boolean,
  timeoutMs: number,
): Promise<{ seq: number; stream: string; text: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for predicate. Events: ${JSON.stringify(events)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('MCP initialize handshake (issue #172)', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-init-'));
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('responds to initialize quickly when no .codegraph exists in cwd', async () => {
    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);
    const response = await waitFor(events, (e) => e.stream === 'stdout', 5000);
    const json = JSON.parse(response.text);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(0);
    expect(json.result.protocolVersion).toBeDefined();
    expect(json.result.capabilities.tools).toBeDefined();
  }, 10000);

  it('smoke: tool call succeeds with CODEGRAPH_USAGE=1 and CODEGRAPH_HOME set (recorder does not break the call path)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-rec-'));
    const prevHome = process.env.CODEGRAPH_HOME;
    const prevUsage = process.env.CODEGRAPH_USAGE;
    process.env.CODEGRAPH_HOME = home;
    process.env.CODEGRAPH_USAGE = '1';
    try {
      // snapshotEffective() reads CODEGRAPH_USAGE — this exercises the env-var
      // branch (enabled=true via env) rather than hardcoding the config struct.
      const config = snapshotEffective();
      expect(config.enabled).toBe(true);
      expect(config.source).toBe('env');

      const handler = new ToolHandler(null);
      const rec = new UsageRecorder(config, {
        getDefaultProjectHint: () => handler.getDefaultProjectHint(),
      });
      const wrapped = rec.wrap(handler.execute.bind(handler));

      // codegraph_status with no project returns an error result — not a throw.
      // The key assertion is that the recorder doesn't break the content[] shape.
      const result = await wrapped('codegraph_status', {});
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      if (prevHome === undefined) delete process.env.CODEGRAPH_HOME;
      else process.env.CODEGRAPH_HOME = prevHome;
      if (prevUsage === undefined) delete process.env.CODEGRAPH_USAGE;
      else process.env.CODEGRAPH_USAGE = prevUsage;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('sends initialize response BEFORE tryInitializeDefault finishes', async () => {
    // Seed a real .codegraph so the server's tryInitializeDefault path runs
    // its full body: CodeGraph.open() (which awaits initGrammars()) and then
    // startWatching() (which logs "File watcher active" to stderr). On any
    // platform, that stderr log is observable evidence that tryInitializeDefault
    // has completed. The contract we're protecting: the JSON-RPC response on
    // stdout must arrive BEFORE that stderr log. If a future change re-awaits
    // tryInitializeDefault before sendResult, this ordering inverts and the
    // test fails — regardless of how fast the local filesystem is.
    const cg = await CodeGraph.init(tempDir);
    cg.close();

    child = spawnServer(tempDir);
    const events = tagStreams(child);
    sendInitialize(child, tempDir);

    const response = await waitFor(events, (e) => e.stream === 'stdout', 10000);
    const watcherLog = await waitFor(
      events,
      (e) => e.stream === 'stderr' && e.text.includes('File watcher active'),
      10000,
    );
    expect(response.seq).toBeLessThan(watcherLog.seq);
    const json = JSON.parse(response.text);
    expect(json.id).toBe(0);
    expect(json.result.serverInfo.name).toBe('codegraph');
  }, 20000);
});
