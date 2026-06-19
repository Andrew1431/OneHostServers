/**
 * Recording fake of the GCP Compute client surface, just enough for the provider.
 *
 * Each client implements only the methods `provider.ts` calls. Mutating calls
 * return `[{ latestResponse: { status: 'DONE' } }]` so `waitZonal`/`waitGlobal`
 * see a finished operation and resolve on the first check (their `wait()` is
 * therefore never invoked — but the ops clients still provide a no-op `wait` so
 * the shape matches). Every call is recorded for assertions, and any method can
 * be scripted to throw via `queueError` / `failNext`.
 *
 * The fake is deliberately untyped against the generated proto types (the real
 * clients have hundreds of overloads); the provider only relies on a thin slice,
 * which we satisfy structurally and cast to `GcpClients` at the boundary.
 */
import type { GcpClients } from '../provider.ts';

/** A recorded call: the method name and the request object passed to it. */
export interface RecordedCall {
  method: string;
  args: unknown;
}

/** A finished zonal/global operation — `waitZonal`/`waitGlobal` resolve on it immediately. */
const DONE_OP = [{ latestResponse: { name: 'op', status: 'DONE' } }] as const;

/** gRPC NOT_FOUND, as the GCP clients throw it (provider's `isNotFound` checks `.code === 5`). */
export function notFoundError(message = 'not found'): Error & { code: number } {
  return Object.assign(new Error(message), { code: 5 });
}

/**
 * A zone capacity stockout — the message always contains `ZONE_RESOURCE_POOL_EXHAUSTED`
 * so the provider's `isCapacityError` regex matches. An optional `tag` is appended
 * so tests can tell successive zones' errors apart.
 */
export function capacityError(tag?: string): Error {
  const base = 'The zone does not have enough resources available (ZONE_RESOURCE_POOL_EXHAUSTED).';
  return new Error(tag ? `${base} ${tag}` : base);
}

/** Minimal instance shape the provider reads. */
export interface FakeInstance {
  name: string;
  status?: string;
  labels?: Record<string, string>;
  labelFingerprint?: string;
  lastStartTimestamp?: string;
  creationTimestamp?: string;
  networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>;
}

/** Minimal snapshot shape the provider reads. */
export interface FakeSnapshot {
  name: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
}

/** Minimal zone shape the provider reads from `zones.listAsync`. */
export interface FakeZone {
  name: string;
  region?: string;
}

/** Seed data + scripted failures for the fake. All optional. */
export interface FakeGcpOptions {
  /**
   * Live instances keyed by zone, e.g. `{ 'us-central1-a': [inst] }`. Drives
   * `aggregatedListAsync` (yields `['zones/<zone>', { instances }]`) and
   * `instances.get` (matched by name within the requested zone).
   */
  instancesByZone?: Record<string, FakeInstance[]>;
  /** Snapshots returned by `snapshots.listAsync` (filtered by label client-side here? no — provider filters by query; we return all). */
  snapshots?: FakeSnapshot[];
  /** UP zones returned by `zones.listAsync`. Each needs a `region` like `.../regions/us-central1`. */
  zones?: FakeZone[];
}

/**
 * One recording client. Holds the shared call log and a per-method error queue;
 * `invoke` records the call, throws the next queued error for that method if any,
 * else returns the provided result.
 */
class FakeClient {
  constructor(
    private readonly name: string,
    readonly calls: RecordedCall[],
    private readonly errors: Map<string, Error[]>,
  ) {}

  protected key(method: string): string {
    return `${this.name}.${method}`;
  }

  /** Record + maybe-throw, then return `result`. */
  protected invoke<T>(method: string, args: unknown, result: T): T {
    this.calls.push({ method: this.key(method), args });
    const q = this.errors.get(this.key(method));
    if (q && q.length > 0) throw q.shift();
    return result;
  }
}

class FakeInstancesClient extends FakeClient {
  constructor(
    calls: RecordedCall[],
    errors: Map<string, Error[]>,
    private readonly state: { instancesByZone: Record<string, FakeInstance[]> },
  ) {
    super('instances', calls, errors);
  }

  async insert(req: unknown): Promise<unknown> {
    return this.invoke('insert', req, DONE_OP);
  }
  async delete(req: unknown): Promise<unknown> {
    return this.invoke('delete', req, DONE_OP);
  }
  async stop(req: unknown): Promise<unknown> {
    return this.invoke('stop', req, DONE_OP);
  }
  async setLabels(req: unknown): Promise<unknown> {
    return this.invoke('setLabels', req, DONE_OP);
  }

  async get(req: { zone: string; instance: string }): Promise<unknown> {
    const inZone = this.state.instancesByZone[req.zone] ?? [];
    const found = inZone.find((i) => i.name === req.instance);
    if (!found) {
      this.invoke('get', req, undefined); // record + honor any scripted error
      throw notFoundError(`instance ${req.instance} not found in ${req.zone}`);
    }
    return this.invoke('get', req, [found]);
  }

  aggregatedListAsync(req: unknown): AsyncIterable<[string, { instances?: FakeInstance[] }]> {
    this.calls.push({ method: 'instances.aggregatedListAsync', args: req });
    const byZone = this.state.instancesByZone;
    return (async function* () {
      for (const [zone, instances] of Object.entries(byZone)) {
        yield [`zones/${zone}`, { instances }] as [string, { instances?: FakeInstance[] }];
      }
    })();
  }
}

class FakeDisksClient extends FakeClient {
  constructor(calls: RecordedCall[], errors: Map<string, Error[]>) {
    super('disks', calls, errors);
  }
  async insert(req: unknown): Promise<unknown> {
    return this.invoke('insert', req, DONE_OP);
  }
  async delete(req: unknown): Promise<unknown> {
    return this.invoke('delete', req, DONE_OP);
  }
  async createSnapshot(req: unknown): Promise<unknown> {
    return this.invoke('createSnapshot', req, DONE_OP);
  }
}

class FakeSnapshotsClient extends FakeClient {
  constructor(
    calls: RecordedCall[],
    errors: Map<string, Error[]>,
    private readonly state: { snapshots: FakeSnapshot[] },
  ) {
    super('snapshots', calls, errors);
  }
  async delete(req: unknown): Promise<unknown> {
    return this.invoke('delete', req, DONE_OP);
  }
  listAsync(req: unknown): AsyncIterable<FakeSnapshot> {
    this.calls.push({ method: 'snapshots.listAsync', args: req });
    const snaps = this.state.snapshots;
    return (async function* () {
      for (const s of snaps) yield s;
    })();
  }
}

class FakeFirewallsClient extends FakeClient {
  constructor(calls: RecordedCall[], errors: Map<string, Error[]>) {
    super('firewalls', calls, errors);
  }
  async insert(req: unknown): Promise<unknown> {
    return this.invoke('insert', req, DONE_OP);
  }
  async update(req: unknown): Promise<unknown> {
    return this.invoke('update', req, DONE_OP);
  }
  async delete(req: unknown): Promise<unknown> {
    return this.invoke('delete', req, DONE_OP);
  }
  async get(req: unknown): Promise<unknown> {
    // Default: not found (so ensureFirewallRule inserts). Script an error/result via queue.
    this.invoke('get', req, undefined);
    throw notFoundError('firewall not found');
  }
}

class FakeZonesClient extends FakeClient {
  constructor(
    calls: RecordedCall[],
    errors: Map<string, Error[]>,
    private readonly state: { zones: FakeZone[] },
  ) {
    super('zones', calls, errors);
  }
  listAsync(req: unknown): AsyncIterable<FakeZone> {
    this.calls.push({ method: 'zones.listAsync', args: req });
    const zones = this.state.zones;
    return (async function* () {
      for (const z of zones) yield z;
    })();
  }
}

/** Ops clients: `wait` is never reached (ops are already DONE), but present for shape. */
class FakeOpsClient extends FakeClient {
  async wait(req: unknown): Promise<unknown> {
    return this.invoke('wait', req, [{ status: 'DONE' }]);
  }
}

/** The assembled fake plus its inspection/scripting surface. */
export interface FakeGcp {
  clients: GcpClients;
  /** Every recorded call, in order, as `{ method: 'instances.insert', args }`. */
  calls: RecordedCall[];
  /** Convenience: recorded calls for one fully-qualified method, e.g. `'disks.delete'`. */
  callsTo(method: string): RecordedCall[];
  /** Script the next call to `method` (e.g. `'instances.insert'`) to throw `err`. Queued FIFO. */
  failNext(method: string, err: Error): void;
}

/** Build a recording fake satisfying {@link GcpClients} from seed data. */
export function makeFakeGcp(opts: FakeGcpOptions = {}): FakeGcp {
  const calls: RecordedCall[] = [];
  const errors = new Map<string, Error[]>();
  const state = {
    instancesByZone: opts.instancesByZone ?? {},
    snapshots: opts.snapshots ?? [],
    zones: opts.zones ?? [],
  };

  const clients = {
    instances: new FakeInstancesClient(calls, errors, state),
    disks: new FakeDisksClient(calls, errors),
    snapshots: new FakeSnapshotsClient(calls, errors, state),
    firewalls: new FakeFirewallsClient(calls, errors),
    zones: new FakeZonesClient(calls, errors, state),
    zoneOps: new FakeOpsClient('zoneOps', calls, errors),
    globalOps: new FakeOpsClient('globalOps', calls, errors),
  } as unknown as GcpClients;

  return {
    clients,
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
    failNext: (method, err) => {
      const q = errors.get(method) ?? [];
      q.push(err);
      errors.set(method, q);
    },
  };
}
