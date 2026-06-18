// One-time project bootstrap: enable the GCP APIs OneHost needs and create the
// Artifact Registry repo that holds the Cloud Run images. These are the two
// things that must exist *before* Terraform (Cloud Run can't deploy an image
// that doesn't exist; an image can't push without a registry). Idempotent —
// safe to re-run. Reads project + region from the repo-root .env.
//
//   pnpm setup                # enable APIs + create the registry
//
// Run `pnpm cli init` (or `pnpm cli config`) first so the .env exists.
import { gcloud, loadConfig } from './gcloud-lib.mjs';

const { project, region } = loadConfig();

// All APIs the stack touches. compute/run/pubsub/cloudscheduler are also asserted
// by Terraform (google_project_service), but enabling them here lets the whole
// bootstrap finish before the first apply. artifactregistry + cloudbuild are
// NOT in Terraform — the registry/build are the pre-apply chicken-and-egg step.
const SERVICES = [
  'compute.googleapis.com',
  'run.googleapis.com',
  'pubsub.googleapis.com',
  'cloudscheduler.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
];

console.log(`project ${project} · region ${region}\n`);

console.log('Enabling APIs (idempotent)…');
gcloud(['services', 'enable', ...SERVICES, '--project', project]);

console.log('\nArtifact Registry repo "onehost"…');
const exists = gcloud(
  ['artifacts', 'repositories', 'describe', 'onehost', '--location', region, '--project', project],
  { allowFail: true },
);
if (exists === 0) {
  console.log('   already exists — skipping create');
} else {
  gcloud([
    'artifacts', 'repositories', 'create', 'onehost',
    '--repository-format=docker', '--location', region,
    '--description=OneHost control-plane images', '--project', project,
  ]);
}

console.log('\n✅ setup complete — next: pnpm build:images, then terraform apply (see SETUP.md)');
