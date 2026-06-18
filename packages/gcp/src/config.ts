/** Static GCP placement + naming config for a OneHost deployment. */
export interface GcpConfig {
  projectId: string;
  /** e.g. "us-central1-a" — instances and disks are zonal. */
  zone: string;
  /** Base image for first-time provisioning. */
  sourceImage: string;
  /** Network tag the Terraform firewall rules target. */
  networkTag: string;
  /**
   * Service account email attached to game VMs. Its only IAM is
   * `roles/pubsub.publisher` on the jobs topic, so an idle VM can signal its own
   * stop without holding any compute/disk power (MACHINE_AGENT.md idle path).
   * Omit (no SA attached) to keep VMs unable to signal — operator stop still works.
   */
  gameVmServiceAccount?: string;
  /**
   * How many of a server's most-recent snapshots to keep after each stop.
   * Older ones are pruned. Omit to use DEFAULT_SNAPSHOT_KEEP; <= 0 keeps all.
   * Config-driven (not read from env here) so a future per-server/GUI setting
   * feeds the same knob.
   */
  snapshotKeep?: number;
}

/** Label key used to find a server's snapshots without a separate DB. */
export const SERVER_LABEL = 'onehost-server';

/**
 * Labels carry the server's machine + disk type forward across stop/start, so
 * the provider stays stateless yet a restored instance keeps its sizing
 * (resolves SHORTCUTS #7 without a database).
 */
export const MACHINE_LABEL = 'onehost-machine';
export const DISKTYPE_LABEL = 'onehost-disktype';

/**
 * Dedup marker the reconcile sweep stamps (epoch seconds) on an instance once it
 * has warned about that instance's uptime, so a 15-min sweep doesn't re-alert
 * every pass. Lives on the instance, so stop (deletes it) / start (fresh
 * instance) clear it naturally — each run re-arms. (SHORTCUTS #6 backstop.)
 */
export const NAGGED_LABEL = 'onehost-nagged-at';

/** Keep the latest N snapshots per server after each stop; prune older ones. */
export const DEFAULT_SNAPSHOT_KEEP = 3;

/** SSD-backed default — far better random IOPS than pd-standard for chunk I/O. */
export const DEFAULT_DISK_TYPE = 'pd-balanced';
export const DEFAULT_MACHINE_TYPE = 'e2-custom-2-4096';

export const DEFAULT_SOURCE_IMAGE =
  'projects/debian-cloud/global/images/family/debian-12';

export const DEFAULT_NETWORK_TAG = 'onehost';

export const DEFAULT_ZONE = 'us-central1-a';

/**
 * Build a {@link GcpConfig} straight from `process.env`. This is the shape every
 * deployed app (worker, interactions) loads — from Cloud Run env / Secret
 * Manager. The CLI layers a repo-root `.env` convenience on top before calling
 * this; the apps don't, so the env-only mapping lives here, next to the defaults.
 */
export function configFromEnv(): GcpConfig {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'Missing GCP_PROJECT_ID. Set it once with: onehost config --project <id> [--zone <zone>]',
    );
  }
  const snapshotKeep = parseIntEnv('ONEHOST_SNAPSHOT_KEEP');
  return {
    projectId,
    zone: process.env.GCP_ZONE ?? DEFAULT_ZONE,
    sourceImage: process.env.GCP_SOURCE_IMAGE ?? DEFAULT_SOURCE_IMAGE,
    networkTag: process.env.GCP_NETWORK_TAG ?? DEFAULT_NETWORK_TAG,
    // Omit when unset so the provider falls back to its own default.
    ...(snapshotKeep === undefined ? {} : { snapshotKeep }),
    ...(process.env.GCP_GAME_VM_SA ? { gameVmServiceAccount: process.env.GCP_GAME_VM_SA } : {}),
  };
}

function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}
