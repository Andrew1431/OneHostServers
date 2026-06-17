// One-command deploy. Reads the repo-root .env (GCP_PROJECT_ID, GCP_ZONE),
// builds the images in the cloud, and rolls the Cloud Run services — so you
// never have to set $REGION/$PROJECT by hand.
//
//   pnpm run deploy                 # build + redeploy both services
//   pnpm run deploy worker          # build + redeploy only the worker
//   pnpm run deploy interactions    # build + redeploy only interactions
//   pnpm run deploy --skip-build    # skip the build, just roll the latest image(s)
//
// (Use `run` — a bare `pnpm deploy` hits pnpm's own built-in deploy command.)
//
// gcloud must be installed; it's found on PATH or at the default SDK location.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const target = args.find((a) => !a.startsWith('-')); // 'worker' | 'interactions' | undefined
if (target && target !== 'worker' && target !== 'interactions') {
  fail(`unknown target '${target}' — use 'worker', 'interactions', or nothing for both`);
}
const services = target ? [target] : ['worker', 'interactions'];

// --- config from .env -------------------------------------------------------
const env = readEnv(join(repoRoot, '.env'));
const project = env.GCP_PROJECT_ID || fail('GCP_PROJECT_ID not set in .env (run `pnpm cli config`)');
const zone = env.GCP_ZONE || fail('GCP_ZONE not set in .env (run `pnpm cli config --zone <zone>`)');
const region = (env.GCP_REGION || zone.replace(/-[a-z]$/, '')).trim();
const gcloud = findGcloud();

console.log(`project ${project} · region ${region} · services: ${services.join(', ')}\n`);

// --- build ------------------------------------------------------------------
if (!skipBuild) {
  run(['builds', 'submit', '--config', 'cloudbuild.yaml', `--substitutions=_REGION=${region}`, '.']);
}

// --- deploy -----------------------------------------------------------------
for (const svc of services) {
  const image = `${region}-docker.pkg.dev/${project}/onehost/${svc}:latest`;
  run(['run', 'deploy', `onehost-${svc}`, '--image', image, '--region', region, '--project', project]);
}

console.log('\n✅ deploy complete');

// --- helpers ----------------------------------------------------------------
function run(gcloudArgs) {
  console.log(`$ gcloud ${gcloudArgs.join(' ')}`);
  const res = spawnSync(gcloud, gcloudArgs, { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) fail(`gcloud exited with ${res.status ?? res.signal}`);
}

function readEnv(path) {
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

/** gcloud on PATH wins; otherwise probe the default Windows SDK install. */
function findGcloud() {
  if (process.env.GCLOUD) return process.env.GCLOUD;
  const onPath = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  const probe = spawnSync(onPath, ['--version'], { stdio: 'ignore' });
  if (probe.status === 0) return onPath;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    const candidate = join(local, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd');
    if (existsSync(candidate)) return candidate;
  }
  fail('gcloud not found — install the SDK or set GCLOUD=/path/to/gcloud');
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
