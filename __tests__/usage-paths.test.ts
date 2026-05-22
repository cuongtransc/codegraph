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
    expect(configPath()).toBe(path.join(tmp, 'config.json'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
