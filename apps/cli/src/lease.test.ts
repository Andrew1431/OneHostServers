import { describe, it, expect, vi } from 'vitest';
import { InMemoryProvider } from '@onehost/testing';
import { InMemoryLeaseStore, LeaseRefusedError } from '@onehost/state';
import { resetLease, withLeases } from './lease.ts';

const spec = {
  id: 'mc',
  ownerDiscordId: 'owner',
  machine: { vcpus: 2, memoryMb: 4096, diskGb: 20, diskType: 'pd-balanced' },
  ports: [],
  region: 'us-central1',
};

describe('withLeases', () => {
  it('runs start under the lease and leaves other methods untouched', async () => {
    const provider = new InMemoryProvider();
    await provider.create(spec);
    await provider.stop('mc');
    const store = new InMemoryLeaseStore();
    const leased = withLeases(provider, store);

    await leased.start('mc');

    expect((await store.get('mc'))?.state).toBe('RUNNING');
    expect((await leased.status('mc')).state).toBe('RUNNING');
  });

  it('refuses while the worker holds the lease', async () => {
    const provider = new InMemoryProvider();
    await provider.create(spec);
    const store = new InMemoryLeaseStore();
    await store.claim('mc', { kind: 'stop', jobId: 'worker', now: Date.now() }, 'RUNNING');
    const stop = vi.spyOn(provider, 'stop');

    await expect(withLeases(provider, store).stop('mc')).rejects.toBeInstanceOf(LeaseRefusedError);
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('resetLease', () => {
  it('refuses a live lease without --force, then clears it with', async () => {
    const provider = new InMemoryProvider();
    await provider.create(spec);
    const store = new InMemoryLeaseStore();
    await store.claim('mc', { kind: 'stop', jobId: 'dead', now: Date.now() }, 'RUNNING');

    await expect(resetLease(provider, store, 'mc', false)).rejects.toThrow(/--force/);
    expect(await resetLease(provider, store, 'mc', true)).toContain("reset 'mc' to RUNNING");
    expect(await store.get('mc')).toMatchObject({ state: 'RUNNING' });
    expect((await store.get('mc'))?.lease).toBeUndefined();
  });
});
