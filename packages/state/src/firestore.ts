import type { ServerId, ServerState } from '@onehost/core';
import {
  decideClaim,
  type ClaimRequest,
  type ClaimResult,
  type LeaseStore,
  type ServerDoc,
} from './lease.ts';

type Firestore = import('@google-cloud/firestore').Firestore;

/**
 * Firestore-backed {@link LeaseStore}: one doc per server in `servers/<id>`, and a
 * transaction per claim/release for the compare-and-swap. Native mode, default
 * database — free-tier at this scale (a handful of reads/writes per start/stop).
 *
 * The client is imported lazily so callers that never touch a lease (list, ssh)
 * don't pay for loading it.
 */
export class FirestoreLeaseStore implements LeaseStore {
  private db: Promise<Firestore> | undefined;

  constructor(
    private readonly projectId?: string,
    private readonly collection = 'servers',
  ) {}

  private getDb(): Promise<Firestore> {
    this.db ??= import('@google-cloud/firestore')
      .then(
        ({ Firestore }) =>
          new Firestore({
            ...(this.projectId ? { projectId: this.projectId } : {}),
            ignoreUndefinedProperties: true,
          }),
      )
      .catch((err: unknown) => {
        this.db = undefined;
        throw err;
      });
    return this.db;
  }

  private async ref(id: ServerId) {
    return (await this.getDb()).collection(this.collection).doc(id);
  }

  async claim(id: ServerId, req: ClaimRequest, observed: ServerState): Promise<ClaimResult> {
    const db = await this.getDb();
    const ref = await this.ref(id);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const { result, write } = decideClaim(toDoc(snap.data()), req, observed);
      if (write) tx.set(ref, write);
      return result;
    });
  }

  async release(id: ServerId, jobId: string, state: ServerState, now: number): Promise<boolean> {
    const db = await this.getDb();
    const ref = await this.ref(id);
    return db.runTransaction(async (tx) => {
      const doc = toDoc((await tx.get(ref)).data());
      if (doc?.lease?.jobId !== jobId) return false;
      tx.set(ref, { state, updatedAt: now } satisfies ServerDoc);
      return true;
    });
  }

  async reset(id: ServerId, state: ServerState, now: number): Promise<void> {
    await (await this.ref(id)).set({ state, updatedAt: now } satisfies ServerDoc);
  }

  async get(id: ServerId): Promise<ServerDoc | undefined> {
    return toDoc((await (await this.ref(id)).get()).data());
  }
}

function toDoc(data: import('@google-cloud/firestore').DocumentData | undefined): ServerDoc | undefined {
  return data ? (data as ServerDoc) : undefined;
}
