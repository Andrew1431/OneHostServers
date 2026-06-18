// Build both Cloud Run images in the cloud (no local Docker) and push them to the
// Artifact Registry repo created by `pnpm setup`. Run after `pnpm setup`, and any
// time you change apps/worker, apps/interactions, or a package they import.
// `pnpm run deploy` already builds; this is the standalone build for the initial
// SETUP flow (build must happen before the first `terraform apply`).
//
//   pnpm build:images
import { gcloud, loadConfig } from './gcloud-lib.mjs';

const { region } = loadConfig();
gcloud(['builds', 'submit', '--config', 'cloudbuild.yaml', `--substitutions=_REGION=${region}`, '.']);
console.log('\n✅ images built + pushed');
