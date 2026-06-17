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
import { gcloud, loadConfig, fail } from './gcloud-lib.mjs';

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const target = args.find((a) => !a.startsWith('-')); // 'worker' | 'interactions' | undefined
if (target && target !== 'worker' && target !== 'interactions') {
  fail(`unknown target '${target}' — use 'worker', 'interactions', or nothing for both`);
}
const services = target ? [target] : ['worker', 'interactions'];

const { project, region } = loadConfig();
console.log(`project ${project} · region ${region} · services: ${services.join(', ')}\n`);

if (!skipBuild) {
  gcloud(['builds', 'submit', '--config', 'cloudbuild.yaml', `--substitutions=_REGION=${region}`, '.']);
}

for (const svc of services) {
  const image = `${region}-docker.pkg.dev/${project}/onehost/${svc}:latest`;
  gcloud(['run', 'deploy', `onehost-${svc}`, '--image', image, '--region', region, '--project', project]);
}

console.log('\n✅ deploy complete');
