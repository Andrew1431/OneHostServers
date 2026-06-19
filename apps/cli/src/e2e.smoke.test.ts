import { describe, it, expect } from 'vitest';
import type { ServerSpec } from '@onehost/core';
import { GcpServerProvider, configFromEnv } from '@onehost/gcp';

/**
 * The only test that touches real GCP. Skipped unless GCP_PROJECT_ID is set, so
 * it never runs in normal `pnpm test` / CI — run it deliberately before a release:
 *
 *   GCP_PROJECT_ID=my-proj GCP_ZONE=us-central1-a pnpm --filter @onehost/cli test
 *
 * It exercises the whole disk-snapshot lifecycle against the live provider:
 * create -> stop (ACPI + snapshot + delete) -> start (restore) -> destroy.
 */
const LIVE = Boolean(process.env.GCP_PROJECT_ID);

describe.skipIf(!LIVE)('live GCP smoke (gated on GCP_PROJECT_ID)', () => {
  it(
    'create -> stop -> start -> destroy',
    async () => {
      const cfg = configFromEnv();
      const provider = new GcpServerProvider(cfg);
      const id = `smoke-${Date.now()}`;
      const region = cfg.zone.replace(/-[a-z]$/, '');
      const spec: ServerSpec = {
        id,
        ownerDiscordId: 'smoke-test',
        region,
        machine: { vcpus: 2, memoryMb: 2048, diskGb: 10, diskType: 'pd-standard', type: 'e2-small' },
        ports: [],
      };

      try {
        const created = await provider.create(spec);
        expect(created.address).toBeTruthy();

        await provider.stop(id);
        expect((await provider.status(id)).state).toBe('STOPPED');

        const started = await provider.start(id);
        expect(started.address).toBeTruthy();
        expect((await provider.status(id)).state).toBe('RUNNING');
      } finally {
        // Always reclaim the instance, disk, and snapshots even if an assertion
        // failed mid-way, so a failed run doesn't leave billable resources.
        await provider.destroy(id);
      }
    },
    600_000,
  );
});
