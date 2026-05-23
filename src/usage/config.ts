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
  source: 'env' | 'config';
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
