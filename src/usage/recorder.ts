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
