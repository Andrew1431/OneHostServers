import { describe, it, expect, beforeEach } from 'vitest';
import { InvalidTransitionError, type ServerSpec } from '@onehost/core';
import { ServerNotFoundError } from '@onehost/provider-api';
import { InMemoryProvider } from './index.ts';

function spec(id: string): ServerSpec {
  return {
    id,
    ownerDiscordId: 'owner',
    machine: { vcpus: 2, memoryMb: 4096, diskGb: 20, diskType: 'pd-balanced' },
    ports: [],
    region: 'us-central1',
  };
}

let p: InMemoryProvider;
beforeEach(() => {
  p = new InMemoryProvider();
});

describe('lifecycle guard', () => {
  it('create lands on RUNNING and records the call', async () => {
    const r = await p.create(spec('mc'));
    expect(r.id).toBe('mc');
    expect(p.peek('mc')?.state).toBe('RUNNING');
    expect(p.calls[0]?.method).toBe('create');
  });

  it('rejects create over a live server', async () => {
    await p.create(spec('mc'));
    await expect(p.create(spec('mc'))).rejects.toThrow(InvalidTransitionError);
  });

  it('start only from STOPPED', async () => {
    await p.create(spec('mc')); // RUNNING
    await expect(p.start('mc')).rejects.toThrow(InvalidTransitionError);
    await p.stop('mc', { allowAlreadyStopped: true });
    const r = await p.start('mc');
    expect(r.id).toBe('mc');
    expect(p.peek('mc')?.state).toBe('RUNNING');
  });

  it('start applies machine/disk overrides', async () => {
    await p.create(spec('mc'));
    await p.stop('mc', { allowAlreadyStopped: true });
    await p.start('mc', { machineType: 'c2-standard-4', diskType: 'pd-ssd' });
    expect(p.peek('mc')?.machineType).toBe('c2-standard-4');
    expect(p.peek('mc')?.diskType).toBe('pd-ssd');
  });
});

describe('stop idempotency', () => {
  it('throws when not running and not allowed', async () => {
    await expect(p.stop('ghost')).rejects.toThrow(ServerNotFoundError);
  });

  it('succeeds when not running and allowed', async () => {
    await expect(p.stop('ghost', { allowAlreadyStopped: true })).resolves.toBeUndefined();
  });

  it('snapshots on stop', async () => {
    await p.create(spec('mc'));
    await p.stop('mc');
    expect(p.peek('mc')?.state).toBe('STOPPED');
    expect(p.peek('mc')?.snapshots).toBe(1);
  });
});

describe('scripted failures', () => {
  it('failNextOn throws once then recovers', async () => {
    p.failNextOn('list', new Error('boom'));
    await expect(p.list()).rejects.toThrow('boom');
    await expect(p.list()).resolves.toEqual([]);
  });

  it('failOn throws until cleared', async () => {
    p.failOn('status');
    await expect(p.status('x')).rejects.toThrow();
    p.clearFailures('status');
    await p.create(spec('mc'));
    await expect(p.status('mc')).resolves.toEqual({ state: 'RUNNING', address: expect.any(String) });
  });
});

describe('reconcile', () => {
  it('disabled at maxUptimeHours <= 0', async () => {
    p.seed('old', { state: 'RUNNING', uptimeHours: 100 });
    const r = await p.reconcile({ maxUptimeHours: 0 });
    expect(r).toEqual({ warned: [], stopped: [] });
  });

  it('warns past max, auto-stops past autostop', async () => {
    p.seed('warn', { state: 'RUNNING', uptimeHours: 12 });
    p.seed('kill', { state: 'RUNNING', uptimeHours: 30 });
    const r = await p.reconcile({ maxUptimeHours: 10, autoStopUptimeHours: 24 });
    expect(r.warned.map((s) => s.id)).toEqual(['warn']);
    expect(r.stopped.map((s) => s.id)).toEqual(['kill']);
    expect(p.peek('kill')?.state).toBe('STOPPED');
  });
});

describe('list', () => {
  it('returns a summary per server', async () => {
    await p.create(spec('a'));
    await p.create(spec('b'));
    const list = await p.list();
    expect(list.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(list[0]?.state).toBe('RUNNING');
  });
});
