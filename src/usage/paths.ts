import * as os from 'os';
import * as path from 'path';

export function usageDir(): string {
  return process.env.CODEGRAPH_HOME || path.join(os.homedir(), '.codegraph');
}

export function usageLogPath(): string {
  return path.join(usageDir(), 'usage.jsonl');
}

export function configPath(): string {
  return path.join(usageDir(), 'config.json');
}
