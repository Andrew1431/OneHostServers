import { describe, it, expect } from 'vitest';
import type { ServerSpec } from '@onehost/core';
import { ServerNotFoundError } from '@onehost/provider-api';
import { InMemoryProvider } from './index.ts';

/**
 * The OneHost product, end to end, in one readable pass: the same lifecycle the
 * live GCP smoke (apps/cli/src/e2e.smoke.test.ts) exercises against real infra —
 * but driven through the in-memory provider so it runs on every `pnpm test` with
 * no cloud, no credentials, no cost. The fake enforces the real core `nextState`
 * guard, so this is a true behavior check, not a stub.
 *
 * If you change what create/stop/start/destroy mean to a user, this test should
 * be the first thing that moves.
 */
describe('server lifecycle: create → stop → start → destroy', () => {
  const spec: ServerSpec = {
    id: 'mc',
    ownerDiscordId: 'owner',
    region: 'us-central1',
    machine: { vcpus: 2, memoryMb: 4096, diskGb: 20, diskType: 'pd-balanced' },
    ports: [],
  };

  it('walks a server through its whole life', async () => {
    const onehost = new InMemoryProvider();

    // create: fresh server comes up RUNNING with a reachable address.
    const created = await onehost.create(spec);
    expect(created.address).toBeTruthy();
    expect((await onehost.status('mc')).state).toBe('RUNNING');

    // stop: ACPI quiesce → snapshot the disk → tear the instance down to ~$0.
    await onehost.stop('mc');
    expect((await onehost.status('mc')).state).toBe('STOPPED');
    expect(await onehost.status('mc').then((s) => s.address)).toBeUndefined();
    expect(onehost.peek('mc')?.snapshots).toBe(1); // a restore point exists

    // start: rebuild the instance from the latest snapshot, back to RUNNING.
    const restarted = await onehost.start('mc');
    expect(restarted.address).toBeTruthy();
    expect((await onehost.status('mc')).state).toBe('RUNNING');

    // destroy: the server is gone — instance, disk, and snapshots reclaimed.
    await onehost.destroy('mc');
    await expect(onehost.status('mc')).rejects.toBeInstanceOf(ServerNotFoundError);
    expect(await onehost.list()).toEqual([]);
  });
});
