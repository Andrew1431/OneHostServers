import { randomUUID } from 'node:crypto';
import type { ServerId } from '@onehost/core';
import type { ServerProvider } from '@onehost/provider-api';
import { LEASE_TTL_MS, runLeased, type LeaseKind, type LeaseStore } from '@onehost/state';

/**
 * The CLI drives the provider directly, so it races the worker too. This wraps
 * a provider so `start`/`stop` take the same per-server lease the worker does
 * (UUID job id). Every other method passes straight through.
 *
 * If the lease store is unreachable or not provisioned (a CLI-only setup with no
 * control plane), it warns and runs unlocked rather than blocking the operator.
 */
export function withLeases<P extends ServerProvider>(provider: P, store: LeaseStore | undefined): P {
  if (!store) return provider;
  const leased = <T>(id: ServerId, kind: LeaseKind, op: () => Promise<T>): Promise<T> =>
    runLeased(
      {
        store,
        observe: async (sid) => (await provider.status(sid)).state,
        onStoreError: (err) => {
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
          console.warn(`⚠️  lease store unreachable (${msg}) — proceeding without the lock`);
          return 'proceed';
        },
      },
      { id, kind, jobId: randomUUID() },
      op,
    );
  const wrapped: P = Object.create(provider);
  wrapped.start = (id, opts) => leased(id, 'start', () => provider.start(id, opts));
  wrapped.stop = (id, opts) => leased(id, 'stop', () => provider.stop(id, opts));
  return wrapped;
}

/**
 * `reset <id>`: clear an ERROR (or a stuck lease) by re-seeding the doc from the
 * provider's live state. Refuses while a live lease is held unless `force`, so
 * it can't yank the lock out from under a start that's genuinely in progress.
 */
export async function resetLease(
  provider: ServerProvider,
  store: LeaseStore,
  id: ServerId,
  force: boolean,
): Promise<string> {
  const now = Date.now();
  const doc = await store.get(id);
  const lease = doc?.lease;
  if (lease && now - lease.acquiredAt < LEASE_TTL_MS && !force) {
    const mins = Math.max(1, Math.round((now - lease.acquiredAt) / 60_000));
    throw new Error(
      `'${id}' has a live ${lease.kind} lease (taken ${mins}m ago) — wait for it, or pass --force if that job is dead`,
    );
  }
  const { state } = await provider.status(id);
  await store.reset(id, state, now);
  return `✅ reset '${id}' to ${state}${doc ? ` (was ${doc.state}${lease ? `, ${lease.kind} lease cleared` : ''})` : ''}`;
}
