import type { ServerId, ServerRecord } from '@onehost/core';
import { FirestoreLeaseStore } from './firestore.ts';
import type { LeaseStore } from './lease.ts';

export * from './lease.ts';
export { FirestoreLeaseStore } from './firestore.ts';

/**
 * The lease store for this deployment. `LEASE_STORE=none` turns leasing off
 * (local dev without Firestore); anything else uses Firestore in GCP_PROJECT_ID.
 */
export function leaseStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LeaseStore | undefined {
  if ((env.LEASE_STORE ?? 'firestore') === 'none') return undefined;
  return new FirestoreLeaseStore(env.GCP_PROJECT_ID);
}

/**
 * Persistence boundary. The Firestore implementation lands here later; for now
 * the in-memory fake lets us unit-test the whole lifecycle without a cloud.
 */
export interface ServerRepository {
  get(id: ServerId): Promise<ServerRecord | undefined>;
  list(): Promise<ServerRecord[]>;
  put(record: ServerRecord): Promise<void>;
  delete(id: ServerId): Promise<void>;
}

/** Test/dev double. Not for production — no durability. */
export class InMemoryServerRepository implements ServerRepository {
  private readonly store = new Map<ServerId, ServerRecord>();

  async get(id: ServerId): Promise<ServerRecord | undefined> {
    return this.store.get(id);
  }

  async list(): Promise<ServerRecord[]> {
    return [...this.store.values()];
  }

  async put(record: ServerRecord): Promise<void> {
    this.store.set(record.spec.id, record);
  }

  async delete(id: ServerId): Promise<void> {
    this.store.delete(id);
  }
}
