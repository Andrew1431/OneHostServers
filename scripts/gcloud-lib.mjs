// Shared helpers for the repo's gcloud-driven scripts (deploy, prune). Reads
// config from the repo-root .env and locates gcloud the same way everywhere.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

export function readEnv(path = join(repoRoot, '.env')) {
  if (!existsSync(path)) fail(`no .env at ${path}`);
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** project + region (region derived from GCP_ZONE unless GCP_REGION is set). */
export function loadConfig() {
  const env = readEnv();
  const project = env.GCP_PROJECT_ID || fail('GCP_PROJECT_ID not set in .env (run `pnpm cli config`)');
  const zone = env.GCP_ZONE || fail('GCP_ZONE not set in .env (run `pnpm cli config --zone <zone>`)');
  const region = (env.GCP_REGION || zone.replace(/-[a-z]$/, '')).trim();
  return { env, project, zone, region };
}

/** gcloud on PATH wins; otherwise probe the default Windows SDK install. */
function findGcloud() {
  if (process.env.GCLOUD) return process.env.GCLOUD;
  const onPath = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  if (spawnSync(onPath, ['--version'], { stdio: 'ignore' }).status === 0) return onPath;
  if (process.platform === 'win32') {
    const candidate = join(
      process.env.LOCALAPPDATA ?? '',
      'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd',
    );
    if (existsSync(candidate)) return candidate;
  }
  fail('gcloud not found — install the SDK or set GCLOUD=/path/to/gcloud');
}

const gcloudBin = findGcloud();

/**
 * Run gcloud. `capture: true` returns stdout (string); otherwise output is
 * inherited (streamed live). Node won't spawn a .cmd without a shell
 * (CVE-2024-27980), so on Windows we run a quoted command string through one.
 */
export function gcloud(args, { capture = false } = {}) {
  if (!capture) console.log(`$ gcloud ${args.join(' ')}`);
  const isCmd = /\.(cmd|bat)$/i.test(gcloudBin);
  const base = capture
    ? { cwd: repoRoot, encoding: 'utf8' }
    : { cwd: repoRoot, stdio: 'inherit' };
  const res = isCmd
    ? spawnSync(`"${gcloudBin}" ${args.join(' ')}`, { ...base, shell: true })
    : spawnSync(gcloudBin, args, base);
  if (res.error) fail(`could not run gcloud: ${res.error.message}`);
  if (res.status !== 0) {
    if (capture && res.stderr) process.stderr.write(res.stderr);
    fail(`gcloud exited with ${res.status ?? res.signal}`);
  }
  return capture ? res.stdout : undefined;
}
