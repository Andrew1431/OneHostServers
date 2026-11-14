import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STATE_ICON } from '@onehost/core';
import type { ServerSpec } from '@onehost/core';
import type { Job } from '@onehost/jobs';
import { InMemoryProvider } from '@onehost/testing';
import { InMemoryLeaseStore } from '@onehost/state';
import { handleJob, makeNotify, type DiscordMessage, type WorkerDeps } from './handler.ts';

/**
 * Worker control-plane tests: drive every Job kind against the in-memory provider
 * with a spy notify, asserting the reply + the provider calls. No GCP, no HTTP.
 */

function spec(id: string): ServerSpec {
  return {
    id,
    ownerDiscordId: 'owner',
    machine: { vcpus: 2, memoryMb: 4096, diskGb: 20, diskType: 'pd-balanced' },
    ports: [],
    region: 'us-central1',
  };
}

function makeDeps(provider: InMemoryProvider): { deps: WorkerDeps; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn<(job: Job, message: DiscordMessage) => Promise<void>>(async () => {});
  return { deps: { provider, notify }, notify };
}

let provider: InMemoryProvider;

beforeEach(() => {
  provider = new InMemoryProvider();
});

describe('start', () => {
  it('produces a "started" embed via notify', async () => {
    await provider.create(spec('mc')); // create→RUNNING
    await provider.stop('mc', { allowAlreadyStopped: true }); // back to STOPPED
    const { deps, notify } = makeDeps(provider);

    await handleJob(deps, { kind: 'start', id: 'mc' });

    expect(provider.peek('mc')?.state).toBe('RUNNING');
    expect(notify).toHaveBeenCalledOnce();
    const [, message] = notify.mock.calls[0]!;
    expect(message.embeds?.[0]?.title).toContain('mc is up');
    expect(message.embeds?.[0]?.title).toContain(STATE_ICON.RUNNING);
  });
});

describe('stop', () => {
  it('calls provider.stop with allowAlreadyStopped: true', async () => {
    await provider.create(spec('mc'));
    const { deps, notify } = makeDeps(provider);
    const stopSpy = vi.spyOn(provider, 'stop');

    await handleJob(deps, { kind: 'stop', id: 'mc' });

    expect(stopSpy).toHaveBeenCalledWith('mc', { allowAlreadyStopped: true });
    // Also recorded with the option in the call log.
    const stopCall = provider.calls.find((c) => c.method === 'stop');
    expect(stopCall?.args[1]).toEqual({ allowAlreadyStopped: true });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![1].embeds?.[0]?.title).toContain('stopped');
  });

  it('reports a stopped embed even when already stopped (idempotent)', async () => {
    // No server exists; allowAlreadyStopped makes this a success, not an error.
    const { deps, notify } = makeDeps(provider);

    await handleJob(deps, { kind: 'stop', id: 'ghost' });

    const title = notify.mock.calls[0]![1].embeds?.[0]?.title ?? '';
    expect(title).toContain('stopped');
    expect(title).not.toContain(STATE_ICON.ERROR);
  });
});

describe('dns', () => {
  function dnsSpec(id: string): ServerSpec {
    return { ...spec(id), dns: { provider: 'duckdns', hostname: `${id}-host` } };
  }
  function fakeDns() {
    return {
      upsertAddress: vi.fn<(host: string, ip: string) => Promise<void>>(async () => {}),
      removeAddress: vi.fn<(host: string) => Promise<void>>(async () => {}),
    };
  }

  it('upserts the A record to the new IP on start', async () => {
    await provider.create(dnsSpec('mc'));
    await provider.stop('mc', { allowAlreadyStopped: true }); // back to STOPPED, host remembered
    const dns = fakeDns();
    const { deps } = makeDeps(provider);

    await handleJob({ ...deps, dns }, { kind: 'start', id: 'mc' });

    expect(dns.upsertAddress).toHaveBeenCalledOnce();
    const [host, ip] = dns.upsertAddress.mock.calls[0]!;
    expect(host).toBe('mc-host');
    expect(ip).toEqual(expect.any(String));
  });

  it('clears the A record on stop', async () => {
    await provider.create(dnsSpec('mc')); // RUNNING, host remembered
    const dns = fakeDns();
    const { deps } = makeDeps(provider);

    await handleJob({ ...deps, dns }, { kind: 'stop', id: 'mc' });

    expect(dns.removeAddress).toHaveBeenCalledWith('mc-host');
  });

  it('still reports success when the DNS upsert fails (non-fatal)', async () => {
    await provider.create(dnsSpec('mc'));
    await provider.stop('mc', { allowAlreadyStopped: true });
    const dns = fakeDns();
    dns.upsertAddress.mockRejectedValueOnce(new Error('duckdns down'));
    const { deps, notify } = makeDeps(provider);

    await handleJob({ ...deps, dns }, { kind: 'start', id: 'mc' });

    expect(provider.peek('mc')?.state).toBe('RUNNING');
    expect(notify.mock.calls[0]![1].embeds?.[0]?.title).toContain('mc is up');
  });

  it('does not touch DNS for a server without a hostname', async () => {
    await provider.create(spec('plain')); // no dns
    await provider.stop('plain', { allowAlreadyStopped: true });
    const dns = fakeDns();
    const { deps } = makeDeps(provider);

    await handleJob({ ...deps, dns }, { kind: 'start', id: 'plain' });

    expect(dns.upsertAddress).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('produces a list embed via notify', async () => {
    await provider.create(spec('a'));
    const { deps, notify } = makeDeps(provider);

    await handleJob(deps, { kind: 'list' });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![1].embeds?.[0]?.title).toBe('Servers');
  });
});

describe('sweep', () => {
  it('does NOT notify when the reconcile report is empty', async () => {
    // maxUptimeHours defaults to 0 (env unset) → reconcile disabled → empty report.
    const { deps, notify } = makeDeps(provider);

    await handleJob(deps, { kind: 'sweep' });

    expect(provider.calls.some((c) => c.method === 'reconcile')).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies when something was warned or stopped', async () => {
    // Drive the branch directly: a non-empty report must produce a sweep embed.
    const report = { warned: [{ id: 'old', uptimeHours: 30 }], stopped: [] };
    vi.spyOn(provider, 'reconcile').mockResolvedValue(report);
    const { deps, notify } = makeDeps(provider);

    await handleJob(deps, { kind: 'sweep' });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![1].embeds?.[0]?.title).toBe('Long-running server sweep');
  });
});

describe('provider failure', () => {
  it('sends an error embed via notify and does not rethrow', async () => {
    provider.failOn('start', new Error('capacity exhausted'));
    await provider.create(spec('mc'));
    await provider.stop('mc', { allowAlreadyStopped: true });
    const { deps, notify } = makeDeps(provider);

    await expect(handleJob(deps, { kind: 'start', id: 'mc' })).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledOnce();
    const embed = notify.mock.calls[0]![1].embeds?.[0];
    expect(embed?.title).toContain(STATE_ICON.ERROR);
    expect(embed?.title).toContain('mc failed');
    expect(embed?.description).toBe('capacity exhausted');
  });
});

describe('default notify routing', () => {
  it('edits the interaction when interactionToken is set', async () => {
    const editOriginal = vi.fn(async () => {});
    const postWebhook = vi.fn(async () => {});
    const notify = makeNotify(editOriginal, postWebhook);

    await notify({ kind: 'list', interactionToken: 'tok-123' }, { content: 'hi' });

    expect(editOriginal).toHaveBeenCalledWith('tok-123', { content: 'hi' });
    expect(postWebhook).not.toHaveBeenCalled();
  });

  it('posts to the webhook when there is no token', async () => {
    const editOriginal = vi.fn(async () => {});
    const postWebhook = vi.fn(async () => {});
    const notify = makeNotify(editOriginal, postWebhook);

    await notify({ kind: 'sweep' }, { content: 'sweep result' });

    expect(postWebhook).toHaveBeenCalledWith({ content: 'sweep result' });
    expect(editOriginal).not.toHaveBeenCalled();
  });
});

describe('leased start/stop', () => {
  function leasedDeps() {
    const leases = new InMemoryLeaseStore();
    const { deps, notify } = makeDeps(provider);
    return { deps: { ...deps, leases }, notify, leases };
  }
  async function stoppedServer(id = 'mc') {
    await provider.create(spec(id));
    await provider.stop(id, { allowAlreadyStopped: true });
  }

  it('lets only one of two concurrent /starts touch the provider', async () => {
    await stoppedServer();
    const { deps, notify } = leasedDeps();
    const realStart = provider.start.bind(provider);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const startSpy = vi.spyOn(provider, 'start').mockImplementation(async (id, opts) => {
      await gate;
      return realStart(id, opts);
    });

    const first = handleJob(deps, { kind: 'start', id: 'mc', interactionToken: 't1' }, { jobId: 'm1' });
    await vi.waitFor(() => expect(startSpy).toHaveBeenCalledOnce());
    await handleJob(deps, { kind: 'start', id: 'mc', interactionToken: 't2' }, { jobId: 'm2' });
    release();
    await first;

    expect(startSpy).toHaveBeenCalledOnce();
    const replies = notify.mock.calls.map(([job, msg]) => [job.interactionToken, msg]);
    expect(replies[0]).toEqual(['t2', { content: "⏳ 'mc' is already starting — hang on." }]);
    expect((replies[1]![1] as DiscordMessage).embeds?.[0]?.title).toContain('mc is up');
  });

  it('answers /start on a running server with "already running" + its address', async () => {
    await provider.create(spec('mc'));
    const { deps, notify } = leasedDeps();
    const startSpy = vi.spyOn(provider, 'start');

    await handleJob(deps, { kind: 'start', id: 'mc', interactionToken: 't' }, { jobId: 'm1' });

    expect(startSpy).not.toHaveBeenCalled();
    const [, msg] = notify.mock.calls[0]!;
    expect(msg.content).toBe("ℹ️ 'mc' is already running.");
    expect(msg.embeds?.[0]?.title).toContain('mc is up');
  });

  it('drops an idle stop for an already-stopped server without posting to the channel', async () => {
    await stoppedServer();
    const { deps, notify } = leasedDeps();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleJob(deps, { kind: 'stop', id: 'mc' }, { jobId: 'idle-1' });

    expect(notify).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('parks a failed stop in ERROR and tells the user how to reset', async () => {
    await provider.create(spec('mc'));
    provider.failOn('stop', new Error('snapshot quota exceeded'));
    const { deps, notify, leases } = leasedDeps();

    await handleJob(deps, { kind: 'stop', id: 'mc', interactionToken: 't' }, { jobId: 'm1' });

    expect((await leases.get('mc'))?.state).toBe('ERROR');
    const embed = notify.mock.calls[0]![1].embeds?.[0];
    expect(embed?.title).toContain('mc failed');
    expect(embed?.description).toContain('snapshot quota exceeded');
    expect(embed?.description).toContain('pnpm cli reset mc');
  });

  it('a redelivered start whose first attempt finished just reports success', async () => {
    await provider.create(spec('mc')); // RUNNING: the first attempt got it up, then the worker died
    const { deps, notify, leases } = leasedDeps();
    await leases.claim('mc', { kind: 'start', jobId: 'm1', now: Date.now() }, 'STOPPED');
    const startSpy = vi.spyOn(provider, 'start');

    await handleJob(deps, { kind: 'start', id: 'mc', interactionToken: 't' }, { jobId: 'm1' });

    expect(startSpy).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![1].embeds?.[0]?.title).toContain('mc is up');
    expect((await leases.get('mc'))?.state).toBe('RUNNING');
  });
});
