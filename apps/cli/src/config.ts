import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type GcpConfig, configFromEnv } from '@onehost/gcp';

/**
 * Pull deployment config from the environment, falling back to a `.env` file at
 * the repo root so you can set GCP_PROJECT_ID / GCP_ZONE once instead of every
 * command. Real env vars always win over the file. The deployed apps load the
 * same shape via `configFromEnv` — this repo-root `.env` step is CLI-only.
 */
export function loadGcpConfig(): GcpConfig {
  loadDotEnv();
  return configFromEnv();
}

/** Path to the repo-root `.env` (gitignored — safe for your project id). */
export function envFilePath(): string {
  return join(repoRoot(), '.env');
}

/** Merge `updates` into the `.env`, preserving any other keys already there. */
export function writeConfig(updates: Record<string, string>): string {
  const path = envFilePath();
  const env = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  Object.assign(env, updates);
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(path, `${body}\n`);
  return path;
}

let loaded = false;
function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  const path = envFilePath();
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    // Don't clobber an explicitly-exported env var.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

/** Walk up from cwd to the pnpm workspace root; fall back to cwd. */
function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}
