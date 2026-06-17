// Delete untagged image versions from Artifact Registry. Every `pnpm run deploy`
// moves the `:latest` tag to a new digest, leaving the old digest untagged but
// still stored (and billed). This removes those orphans.
//
// SAFETY: only versions whose tag list is empty are deleted, and the digest that
// `:latest` currently resolves to is excluded explicitly — so the image your
// Cloud Run services serve is never touched (deleting it would break cold starts).
//
//   pnpm run prune-images            # delete untagged versions of both images
//   pnpm run prune-images --dry-run  # list what would be deleted, delete nothing
import { gcloud, loadConfig, fail } from './gcloud-lib.mjs';

const dryRun = process.argv.slice(2).includes('--dry-run');
const { project, region } = loadConfig();
const images = ['interactions', 'worker'];

let total = 0;
for (const name of images) {
  const repoImage = `${region}-docker.pkg.dev/${project}/onehost/${name}`;

  // The digest `:latest` points at right now — never delete this, belt-and-suspenders.
  const liveDigest = gcloud(
    ['artifacts', 'docker', 'images', 'describe', `${repoImage}:latest`, '--format=value(image_summary.digest)'],
    { capture: true },
  ).trim();

  const versions = JSON.parse(
    gcloud(
      ['artifacts', 'docker', 'images', 'list', repoImage, '--include-tags', '--format=json'],
      { capture: true },
    ),
  );

  // Untagged AND not the live digest. tags is a real array with --include-tags.
  const stale = versions
    .filter((v) => Array.isArray(v.tags) && v.tags.length === 0 && v.version !== liveDigest)
    .map((v) => v.version);

  // Paranoia: if anything tagged or live slipped through, bail rather than guess.
  const unsafe = versions.find((v) => stale.includes(v.version) && (v.tags?.length || v.version === liveDigest));
  if (unsafe) fail(`refusing to prune — ${unsafe.version} looks live/tagged`);

  if (stale.length === 0) {
    console.log(`${name}: nothing to prune (live ${liveDigest.slice(7, 19)} kept)`);
    continue;
  }
  console.log(`${name}: ${stale.length} untagged version(s)${dryRun ? ' (dry run)' : ''}, keeping live ${liveDigest.slice(7, 19)}`);
  for (const digest of stale) {
    if (dryRun) {
      console.log(`   would delete ${digest.slice(7, 19)}`);
      continue;
    }
    gcloud(['artifacts', 'docker', 'images', 'delete', `${repoImage}@${digest}`, '--quiet']);
    console.log(`   deleted ${digest.slice(7, 19)}`);
    total++;
  }
}

console.log(dryRun ? '\n(dry run — nothing deleted)' : `\n✅ pruned ${total} image version(s)`);
