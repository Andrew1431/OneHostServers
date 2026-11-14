import { describe, it, expect, vi } from 'vitest';
import type { ServerState } from '@onehost/core';
import {
  InMemoryLeaseStore,
  LEASE_TTL_MS,
  LeaseRefusedError,
  LeaseStoreError,
  LeasedOperationError,
  decideClaim,
  runLeased,
  settledState,
  type LeaseStore,
} from './lease.ts';

const T0 = 1_700_000_000_000;

describe('decideClaim', () => {
  it('claims from the provider state when there is no doc, and records the lease', () => {
    const { result, write } = decideClaim(undefined, { kind: 'start', jobId: 'a', now: T0 }, 'STOPPED');
    expect(result).toEqual({ outcome: 'claimed', from: 'STOPPED' });
    expect(write).toEqual({
      state: 'STARTING',
      lease: { jobId: 'a', kind: 'start', acquiredAt: T0 },
      updatedAt: T0,
    });
  });

  it('is busy while another job holds a live lease', () => {
    const doc = { state: 'STARTING' as const, lease: { jobId: 'a', kind: 'start' as const, acquiredAt: T0 }, updatedAt: T0 };
    const { result, write } = decideClaim(doc, { kind: 'stop', jobId: 'b', now: T0 + 1000 }, 'STARTING');
    expect(result).toEqual({ outcome: 'busy', kind: 'start', since: T0 });
    expect(write).toBeUndefined();
  });

  it('resumes when the lease holder is redelivered', () => {
    const doc = { state: 'STARTING' as const, lease: { jobId: 'a', kind: 'start' as const, acquiredAt: T0 }, updatedAt: T0 };
    expect(decideClaim(doc, { kind: 'start', jobId: 'a', now: T0 + 1000 }, 'STOPPED').result).toEqual({
      outcome: 'resume',
    });
  });

  it('ignores a stale lease and reconciles against the provider', () => {
    const doc = { state: 'STARTING' as const, lease: { jobId: 'a', kind: 'start' as const, acquiredAt: T0 }, updatedAt: T0 };
    const now = T0 + LEASE_TTL_MS + 1;
    expect(decideClaim(doc, { kind: 'start', jobId: 'b', now }, 'RUNNING').result).toEqual({
      outcome: 'invalid',
      state: 'RUNNING',
    });
    expect(decideClaim(doc, { kind: 'stop', jobId: 'b', now }, 'RUNNING').result.outcome).toBe('claimed');
  });

  it('keeps ERROR sticky whatever the provider says', () => {
    const doc = { state: 'ERROR' as const, updatedAt: T0 };
    expect(decideClaim(doc, { kind: 'start', jobId: 'b', now: T0 }, 'STOPPED').result).toEqual({
      outcome: 'invalid',
      state: 'ERROR',
    });
  });

  it('trusts the provider over a drifted doc outside a lease', () => {
    // Doc says RUNNING but someone stopped it from the console.
    const doc = { state: 'RUNNING' as const, updatedAt: T0 };
    expect(decideClaim(doc, { kind: 'start', jobId: 'b', now: T0 }, 'STOPPED').result.outcome).toBe('claimed');
  });

  it('refuses while the provider shows an unleased transition in flight', () => {
    expect(decideClaim(undefined, { kind: 'stop', jobId: 'b', now: T0 }, 'STARTING').result).toEqual({
      outcome: 'invalid',
      state: 'STARTING',
    });
  });
});

describe('settledState', () => {
  it.each<[Parameters<typeof settledState>, ServerState]>([
    [['start', true], 'RUNNING'],
    [['stop', true], 'STOPPED'],
    [['start', false, 'STOPPED'], 'STOPPED'], // cleaned-up failed start (e.g. stockout)
    [['start', false, 'RUNNING'], 'ERROR'],
    [['start', false, undefined], 'ERROR'], // provider unreadable
    [['stop', false, 'RUNNING'], 'ERROR'],
  ])('%j → %s', (args, expected) => {
    expect(settledState(...args)).toBe(expected);
  });
});

function harness(states: ServerState[] = ['STOPPED']) {
  const store = new InMemoryLeaseStore();
  const queue = [...states];
  let last = queue[0] ?? 'STOPPED';
  const observe = vi.fn(async () => (last = queue.shift() ?? last));
  let t = T0;
  const now = () => (t += 1000);
  return { store, observe, deps: { store, observe, now } };
}

describe('runLeased', () => {
  it('runs the op and settles RUNNING, clearing the lease', async () => {
    const { store, deps } = harness(['STOPPED']);
    const op = vi.fn(async () => 'ok');

    await expect(runLeased(deps, { id: 'mc', kind: 'start', jobId: 'a' }, op)).resolves.toBe('ok');

    expect(op).toHaveBeenCalledWith({ resumed: false, observed: 'STOPPED' });
    expect(await store.get('mc')).toMatchObject({ state: 'RUNNING' });
    expect((await store.get('mc'))?.lease).toBeUndefined();
  });

  it('refuses a second start while the first is in flight, without running it', async () => {
    const { deps } = harness(['STOPPED', 'STARTING']);
    let finish!: () => void;
    const first = runLeased(deps, { id: 'mc', kind: 'start', jobId: 'a' }, () => new Promise<void>((r) => (finish = r)));
    await vi.waitFor(() => expect(finish).toBeDefined());

    const second = vi.fn(async () => {});
    const err = await runLeased(deps, { id: 'mc', kind: 'start', jobId: 'b' }, second).catch((e) => e);

    expect(err).toBeInstanceOf(LeaseRefusedError);
    expect(err.message).toBe("'mc' is already starting — hang on.");
    expect(second).not.toHaveBeenCalled();
    finish();
    await first;
  });

  it('refuses a stop that races an in-flight start (the snapshot-corruption case)', async () => {
    const { deps } = harness(['STOPPED', 'STARTING']);
    let finish!: () => void;
    const start = runLeased(deps, { id: 'mc', kind: 'start', jobId: 'a' }, () => new Promise<void>((r) => (finish = r)));
    await vi.waitFor(() => expect(finish).toBeDefined());

    const stop = vi.fn(async () => {});
    await expect(runLeased(deps, { id: 'mc', kind: 'stop', jobId: 'idle' }, stop)).rejects.toBeInstanceOf(
      LeaseRefusedError,
    );
    expect(stop).not.toHaveBeenCalled();
    finish();
    await start;
  });

  it('hands a redelivery its own lease back as resumed', async () => {
    const { store, deps } = harness(['STARTING']);
    await store.claim('mc', { kind: 'start', jobId: 'a', now: T0 }, 'STOPPED'); // first attempt died

    const op = vi.fn(async () => {});
    await runLeased(deps, { id: 'mc', kind: 'start', jobId: 'a' }, op);

    expect(op).toHaveBeenCalledWith({ resumed: true, observed: 'STARTING' });
    expect(await store.get('mc')).toMatchObject({ state: 'RUNNING' });
  });

  it('puts a cleanly failed start back to STOPPED so chat can retry', async () => {
    const { store, deps } = harness(['STOPPED', 'STOPPED']);
    const err = await runLeased(deps, { id: 'mc', kind: 'start', jobId: 'a' }, async () => {
      throw new Error('ZONE_RESOURCE_POOL_EXHAUSTED');
    }).catch((e) => e);

    expect(err).toBeInstanceOf(LeasedOperationError);
    expect(err.settled).toBe('STOPPED');
    expect(err.message).toBe('ZONE_RESOURCE_POOL_EXHAUSTED');
    expect(await store.get('mc')).toMatchObject({ state: 'STOPPED' });
  });

  it('parks a failed stop in ERROR, which then refuses everything', async () => {
    const { store, deps } = harness(['RUNNING', 'RUNNING', 'RUNNING']);
    const err = await runLeased(deps, { id: 'mc', kind: 'stop', jobId: 'a' }, async () => {
      throw new Error('snapshot failed');
    }).catch((e) => e);
    expect(err.settled).toBe('ERROR');
    expect(await store.get('mc')).toMatchObject({ state: 'ERROR' });

    const again = await runLeased(deps, { id: 'mc', kind: 'stop', jobId: 'b' }, async () => {}).catch((e) => e);
    expect(again).toBeInstanceOf(LeaseRefusedError);
    expect(again.message).toContain('pnpm cli reset mc');
  });

  it('fails closed when the store is down, by default', async () => {
    const store: LeaseStore = new InMemoryLeaseStore();
    vi.spyOn(store, 'claim').mockRejectedValue(new Error('PERMISSION_DENIED'));
    const op = vi.fn(async () => {});
    const err = await runLeased({ store, observe: async () => 'STOPPED' }, { id: 'mc', kind: 'start', jobId: 'a' }, op).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LeaseStoreError);
    expect(op).not.toHaveBeenCalled();
  });

  it('runs unlocked when onStoreError says proceed (the CLI)', async () => {
    const store = new InMemoryLeaseStore();
    vi.spyOn(store, 'claim').mockRejectedValue(new Error('NOT_FOUND: database does not exist'));
    const op = vi.fn(async () => 'ran');
    await expect(
      runLeased(
        { store, observe: async () => 'STOPPED', onStoreError: () => 'proceed' },
        { id: 'mc', kind: 'start', jobId: 'a' },
        op,
      ),
    ).resolves.toBe('ran');
  });

  it('does not throw when releasing fails after a successful op', async () => {
    const { store, deps } = harness(['STOPPED']);
    vi.spyOn(store, 'release').mockRejectedValue(new Error('unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runLeased(deps, { id: 'mc', kind: 'start', jobId: 'a' }, async () => 'ok')).resolves.toBe('ok');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('InMemoryLeaseStore.release', () => {
  it('only settles when the caller still holds the lease', async () => {
    const store = new InMemoryLeaseStore();
    await store.claim('mc', { kind: 'start', jobId: 'a', now: T0 }, 'STOPPED');
    expect(await store.release('mc', 'someone-else', 'RUNNING', T0)).toBe(false);
    expect(await store.get('mc')).toMatchObject({ state: 'STARTING' });
    expect(await store.release('mc', 'a', 'RUNNING', T0)).toBe(true);
  });
});
