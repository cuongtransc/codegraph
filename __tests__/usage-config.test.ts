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
    expect(snap.mode).toBe('verbose');
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
