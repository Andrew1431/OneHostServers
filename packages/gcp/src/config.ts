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

/** Keep the latest N snapshots per server after each stop; prune older ones. */
export const DEFAULT_SNAPSHOT_KEEP = 3;

/** SSD-backed default — far better random IOPS than pd-standard for chunk I/O. */
export const DEFAULT_DISK_TYPE = 'pd-balanced';
export const DEFAULT_MACHINE_TYPE = 'e2-custom-2-4096';

export const DEFAULT_SOURCE_IMAGE =
  'projects/debian-cloud/global/images/family/debian-12';

export const DEFAULT_NETWORK_TAG = 'onehost';
