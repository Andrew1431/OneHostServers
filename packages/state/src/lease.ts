import type { ServerId, ServerState } from '@onehost/core';
import { canTransition, nextState } from '@onehost/core';

/**
 * Per-server lease: the serialization point for lifecycle operations (see
 * STATE_IMPROVEMENTS.md). Pub/Sub pushes jobs concurrently and the CLI drives the
 * provider directly, so without this two `start`s (or a `start` racing a `stop`)
 * can collide on the same disk name — or worse, snapshot a half-booted disk over
 * the only good restore point.
 *
 * The provider stays the source of truth for *what exists*; the lease store only
 * records *in-flight intent*. Outside a live lease, every claim re-reads the
 * provider's state and repairs the doc, so drift (a console stop, an unleased CLI)
 * self-heals. The one exception is ERROR, which is sticky until `reset`.
 */

export type LeaseKind = 'start' | 'stop';

export interface Lease {
  /** Pub/Sub messageId (stable across redeliveries), or a UUID for CLI callers. */
  jobId: string;
  kind: LeaseKind;
  /** Epoch millis. */
  acquiredAt: number;
}

export interface ServerDoc {
  state: ServerState;
  lease?: Lease;
  updatedAt: number;
}

export interface ClaimRequest {
  kind: LeaseKind;
  jobId: string;
  now: number;
}

export type ClaimResult =
  /** Lease taken; `from` is the state the op starts from. */
  | { outcome: 'claimed'; from: ServerState }
  /** A redelivery of the job that already holds the lease (its worker died mid-op). */
  | { outcome: 'resume' }
  /** Another job holds a live lease. */
  | { outcome: 'busy'; kind: LeaseKind; since: number }
  /** The state machine refuses this op from `state` (already running, ERROR, …). */
  | { outcome: 'invalid'; state: ServerState };

/**
 * Comfortably above the slowest start (600s Cloud Run timeout) and equal to the
 * interaction-token lifetime. An older lease is stale: its worker crashed and
 * Pub/Sub gave up, so the next claimant reconciles against the provider.
 */
export const LEASE_TTL_MS = 15 * 60_000;

export interface LeaseStore {
  /** Atomically decide + record a claim. `observed` is the provider's live state. */
  claim(id: ServerId, req: ClaimRequest, observed: ServerState): Promise<ClaimResult>;
  /**
   * Settle a finished op: write `state` and drop the lease — only if `jobId` still
   * holds it. Returns false when it doesn't (lease expired and was re-claimed).
   */
  release(id: ServerId, jobId: string, state: ServerState, now: number): Promise<boolean>;
  /** Operator escape hatch: overwrite the doc with `state`, clearing any lease. */
  reset(id: ServerId, state: ServerState, now: number): Promise<void>;
  get(id: ServerId): Promise<ServerDoc | undefined>;
}

/**
 * The pure claim decision, shared by every store so the in-memory fake and
 * Firestore can't drift. Returns the doc to write, if any.
 */
export function decideClaim(
  doc: ServerDoc | undefined,
  req: ClaimRequest,
  observed: ServerState,
): { result: ClaimResult; write?: ServerDoc } {
  const lease = doc?.lease;
  if (lease && req.now - lease.acquiredAt < LEASE_TTL_MS) {
    if (lease.jobId === req.jobId) return { result: { outcome: 'resume' } };
    return { result: { outcome: 'busy', kind: lease.kind, since: lease.acquiredAt } };
  }
  // ERROR is a deliberate circuit breaker: only `reset` clears it.
  if (doc?.state === 'ERROR') return { result: { outcome: 'invalid', state: 'ERROR' } };

  // No live lease: trust the provider. A transitional state here means something
  // outside OneHost (or a crashed op) is mid-flight — refuse rather than pile on.
  if (!canTransition(observed, req.kind)) {
    return { result: { outcome: 'invalid', state: observed } };
  }
  return {
    result: { outcome: 'claimed', from: observed },
    write: {
      state: nextState(observed, req.kind),
      lease: { jobId: req.jobId, kind: req.kind, acquiredAt: req.now },
      updatedAt: req.now,
    },
  };
}

/**
 * Where a finished op leaves the server. Success follows the state machine. A
 * failed start that the provider cleaned up (observed STOPPED afterwards) goes
 * back to STOPPED — a zone stockout shouldn't need an operator. Anything else
 * (a failed stop, an unreadable provider) parks in ERROR.
 */
export function settledState(
  kind: LeaseKind,
  ok: boolean,
  observedAfter?: ServerState,
): ServerState {
  if (ok) return kind === 'start' ? 'RUNNING' : 'STOPPED';
  if (kind === 'start' && observedAfter === 'STOPPED') return 'STOPPED';
  return 'ERROR';
}

/** Test/dev double. Same decision logic as Firestore; no durability. */
export class InMemoryLeaseStore implements LeaseStore {
  private readonly docs = new Map<ServerId, ServerDoc>();

  async claim(id: ServerId, req: ClaimRequest, observed: ServerState): Promise<ClaimResult> {
    const { result, write } = decideClaim(this.docs.get(id), req, observed);
    if (write) this.docs.set(id, write);
    return result;
  }

  async release(id: ServerId, jobId: string, state: ServerState, now: number): Promise<boolean> {
    if (this.docs.get(id)?.lease?.jobId !== jobId) return false;
    this.docs.set(id, { state, updatedAt: now });
    return true;
  }

  async reset(id: ServerId, state: ServerState, now: number): Promise<void> {
    this.docs.set(id, { state, updatedAt: now });
  }

  async get(id: ServerId): Promise<ServerDoc | undefined> {
    return this.docs.get(id);
  }
}

// --- running an op under the lease ------------------------------------------

export interface LeaseRunContext {
  /** True when this is a redelivery resuming its own lease. */
  resumed: boolean;
  /** The provider's state when the claim was made. */
  observed: ServerState;
}

export interface RunLeasedDeps {
  store: LeaseStore;
  /** Live provider state (e.g. `(id) => provider.status(id).then((s) => s.state)`). */
  observe: (id: ServerId) => Promise<ServerState>;
  now?: () => number;
  /**
   * Called when the store itself fails (unreachable, not provisioned). Return
   * 'proceed' to run unlocked — the CLI does, to keep a no-control-plane setup
   * working. Default 'fail': the worker refuses rather than race silently.
   */
  onStoreError?: (err: unknown) => 'proceed' | 'fail';
}

/** The lease refused the op. `message` is user-facing. */
export class LeaseRefusedError extends Error {
  constructor(
    readonly id: ServerId,
    readonly kind: LeaseKind,
    readonly result: Extract<ClaimResult, { outcome: 'busy' | 'invalid' }>,
  ) {
    super(describeRefusal(id, kind, result));
    this.name = 'LeaseRefusedError';
  }
}

/** The lease store couldn't be reached to take the claim. */
export class LeaseStoreError extends Error {
  constructor(override readonly cause: unknown) {
    super(`could not take the server lock: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'LeaseStoreError';
  }
}

/** The op ran under the lease and failed; `settled` is where it left the server. */
export class LeasedOperationError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly settled: ServerState,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'LeasedOperationError';
  }
}

export function describeRefusal(
  id: ServerId,
  kind: LeaseKind,
  result: Extract<ClaimResult, { outcome: 'busy' | 'invalid' }>,
): string {
  if (result.outcome === 'busy') {
    return `'${id}' is already ${result.kind === 'start' ? 'starting' : 'stopping'} — hang on.`;
  }
  switch (result.state) {
    case 'ERROR':
      return `'${id}' is in ERROR after a failed operation — check it, then run \`pnpm cli reset ${id}\`.`;
    case 'STARTING':
    case 'STOPPING':
      return `'${id}' is ${result.state === 'STARTING' ? 'starting' : 'stopping'} outside OneHost — try again in a minute.`;
    case 'RUNNING':
      return `'${id}' is already running.`;
    case 'STOPPED':
      return `'${id}' is already stopped.`;
  }
  return `cannot ${kind} '${id}' from ${result.state}.`;
}

/**
 * Claim → run → settle. Throws {@link LeaseRefusedError} without running `op`
 * when the lease says no, {@link LeaseStoreError} when the store is down (unless
 * `onStoreError` says proceed), and {@link LeasedOperationError} when `op` fails.
 *
 * A failure to *release* after a successful op is logged, not thrown: the VM op
 * already happened, and the lease self-expires after {@link LEASE_TTL_MS}.
 */
export async function runLeased<T>(
  deps: RunLeasedDeps,
  req: { id: ServerId; kind: LeaseKind; jobId: string },
  op: (ctx: LeaseRunContext) => Promise<T>,
): Promise<T> {
  const now = deps.now ?? Date.now;
  const { id, kind, jobId } = req;
  const observed = await deps.observe(id);

  let result: ClaimResult;
  try {
    result = await deps.store.claim(id, { kind, jobId, now: now() }, observed);
  } catch (err) {
    if (deps.onStoreError?.(err) === 'proceed') return op({ resumed: false, observed });
    throw new LeaseStoreError(err);
  }
  if (result.outcome === 'busy' || result.outcome === 'invalid') {
    throw new LeaseRefusedError(id, kind, result);
  }

  let value: T;
  try {
    value = await op({ resumed: result.outcome === 'resume', observed });
  } catch (err) {
    let after: ServerState | undefined;
    try {
      after = await deps.observe(id);
    } catch {
      // unreadable provider → ERROR (settledState's default)
    }
    const settled = settledState(kind, false, after);
    await releaseQuietly(deps.store, id, jobId, settled, now());
    throw new LeasedOperationError(err, settled);
  }
  await releaseQuietly(deps.store, id, jobId, settledState(kind, true), now());
  return value;
}

async function releaseQuietly(
  store: LeaseStore,
  id: ServerId,
  jobId: string,
  state: ServerState,
  now: number,
): Promise<void> {
  try {
    if (!(await store.release(id, jobId, state, now))) {
      console.warn(`lease for '${id}' was no longer held by job ${jobId}; left it as is`);
    }
  } catch (err) {
    console.error(`could not release lease for '${id}' (expires in ${LEASE_TTL_MS / 60_000}m):`, err);
  }
}
