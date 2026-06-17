import {
  type GcpConfig,
  DEFAULT_SOURCE_IMAGE,
  DEFAULT_NETWORK_TAG,
} from '@onehost/gcp';

/**
 * Pull deployment config from the environment. Kept dead simple for the CLI;
 * the deployed apps will load the same shape from Secret Manager / env.
 */
export function loadGcpConfig(): GcpConfig {
  const projectId = required('GCP_PROJECT_ID');
  const zone = process.env.GCP_ZONE ?? 'us-central1-a';
  return {
    projectId,
    zone,
    sourceImage: process.env.GCP_SOURCE_IMAGE ?? DEFAULT_SOURCE_IMAGE,
    networkTag: process.env.GCP_NETWORK_TAG ?? DEFAULT_NETWORK_TAG,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
