/** Static GCP placement + naming config for a OneHost deployment. */
export interface GcpConfig {
  projectId: string;
  /** e.g. "us-central1-a" — instances and disks are zonal. */
  zone: string;
  /** Base image for first-time provisioning. */
  sourceImage: string;
  /** Network tag the Terraform firewall rules target. */
  networkTag: string;
}

/** Label key used to find a server's snapshots without a separate DB. */
export const SERVER_LABEL = 'onehost-server';

export const DEFAULT_SOURCE_IMAGE =
  'projects/debian-cloud/global/images/family/debian-12';

export const DEFAULT_NETWORK_TAG = 'onehost';
