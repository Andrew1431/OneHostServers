import type {
  ServerId,
  ServerSpec,
  ServerState,
  ServerStatus,
  ServerSummary,
  RunningServer,
  StaleServer,
} from '@onehost/core';
import { nextState } from '@onehost/core';
import type {
  ServerProvider,
  StartOptions,
  StopOptions,
  ReconcileOptions,
  ReconcileReport,
} from '@onehost/provider-api';
import { ServerNotFoundError } from '@onehost/provider-api';

/**
 * In-memory {@link ServerProvider} that doubles as a local-dev fake and a test
 * double. It backs its lifecycle with the **real `nextState` guard** from
 * `@onehost/core`, so it enforces true transitions (create→RUNNING, start only
 * from STOPPED, stop only from RUNNING, …) exactly like a real provider would —
 * illegal moves throw the same `InvalidTransitionError`.
 *
 * It is observable and scriptable for tests:
 *  - every call is appended to {@link InMemoryProvider.calls} with its args/options,
 *  - {@link InMemoryProvider.failOn} / {@link InMemoryProvider.failNextOn} queue
 *    errors so a method's next invocation throws, letting tests exercise the
 *    worker's error path without touching GCP.
 *
 * Not for production — no persistence, no real infrastructure.
 */

/** A method name on the provider, used for call recording + scripted failures. */
export type ProviderMethod =
  | 'create'
  | 'start'
  | 'stop'
  | 'destroy'
  | 'status'
  | 'list'
  | 'reconcile'
  | 'setDnsHost';

/** One recorded invocation. `args` is the positional argument list as called. */
export interface RecordedCall {
  method: ProviderMethod;
  args: unknown[];
}

/** Internal per-server state the fake tracks. Mirrors what a real provider remembers. */
interface ServerEntry {
  state: ServerState;
  address?: string;
  machineType?: string;
  diskType?: string;
  dnsHost?: string;
  /** Hours the current run has been up — drives reconcile. Default 0. */
  uptimeHours: number;
  snapshots: number;
}

export interface SeedServer {
  state?: ServerState;
  address?: string;
  machineType?: string;
  diskType?: string;
  dnsHost?: string;
  uptimeHours?: number;
  snapshots?: number;
}

export class InMemoryProvider implements ServerProvider {
  /** Every call made to the provider, in order. Inspect in assertions. */
  readonly calls: RecordedCall[] = [];

  private readonly servers = new Map<ServerId, ServerEntry>();
  /** Per-method FIFO error queues; shifted on each matching call. */
  private readonly failures = new Map<ProviderMethod, Error[]>();
  /** Methods that throw on *every* call until cleared. */
  private readonly alwaysFail = new Map<ProviderMethod, Error>();

  /** Queue an error for the *next* call to `method` (FIFO; consumed once). */
  failNextOn(method: ProviderMethod, error: Error = new Error(`${method} failed`)): this {
    const q = this.failures.get(method) ?? [];
    q.push(error);
    this.failures.set(method, q);
    return this;
  }

  /** Make *every* future call to `method` throw, until {@link clearFailures}. */
  failOn(method: ProviderMethod, error: Error = new Error(`${method} failed`)): this {
    this.alwaysFail.set(method, error);
    return this;
  }

  /** Clear scripted failures for one method, or all if omitted. */
  clearFailures(method?: ProviderMethod): this {
    if (method) {
      this.failures.delete(method);
      this.alwaysFail.delete(method);
    } else {
      this.failures.clear();
      this.alwaysFail.clear();
    }
    return this;
  }

  /** Directly seed a server's state, bypassing the lifecycle guard. Test setup only. */
  seed(id: ServerId, entry: SeedServer = {}): this {
    this.servers.set(id, {
      state: entry.state ?? 'STOPPED',
      uptimeHours: entry.uptimeHours ?? 0,
      snapshots: entry.snapshots ?? 0,
      ...(entry.address !== undefined ? { address: entry.address } : {}),
      ...(entry.machineType !== undefined ? { machineType: entry.machineType } : {}),
      ...(entry.diskType !== undefined ? { diskType: entry.diskType } : {}),
      ...(entry.dnsHost !== undefined ? { dnsHost: entry.dnsHost } : {}),
    });
    return this;
  }

  /** Read-only peek at an entry, for assertions. */
  peek(id: ServerId): Readonly<ServerEntry> | undefined {
    return this.servers.get(id);
  }

  private record(method: ProviderMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /** Throw a scripted error if one is queued / set for `method`. */
  private maybeFail(method: ProviderMethod): void {
    const always = this.alwaysFail.get(method);
    if (always) throw always;
    const q = this.failures.get(method);
    if (q && q.length > 0) {
      const err = q.shift() as Error;
      throw err;
    }
  }

  private require(id: ServerId): ServerEntry {
    const entry = this.servers.get(id);
    if (!entry) throw new ServerNotFoundError(id);
    return entry;
  }

  async create(spec: ServerSpec): Promise<RunningServer> {
    this.record('create', spec);
    this.maybeFail('create');
    const existing = this.servers.get(spec.id);
    // create lands on RUNNING via STOPPED→STARTING→RUNNING. Use the guard from a
    // notional STOPPED baseline so a re-create over a live server is rejected.
    const from = existing?.state ?? 'STOPPED';
    nextState(from, 'start'); // STOPPED→STARTING (throws if already live)
    const address = `10.0.0.${(this.servers.size % 254) + 1}`;
    const dnsHost = spec.dns?.hostname ?? existing?.dnsHost;
    this.servers.set(spec.id, {
      state: 'RUNNING',
      address,
      machineType: spec.machine.type ?? `e2-custom-${spec.machine.vcpus}-${spec.machine.memoryMb}`,
      diskType: spec.machine.diskType,
      uptimeHours: 0,
      snapshots: existing?.snapshots ?? 0,
      ...(dnsHost !== undefined ? { dnsHost } : {}),
    });
    return { id: spec.id, address, ...(dnsHost !== undefined ? { dnsHost } : {}) };
  }

  async start(id: ServerId, opts?: StartOptions): Promise<RunningServer> {
    this.record('start', id, opts);
    this.maybeFail('start');
    const entry = this.require(id);
    nextState(entry.state, 'start'); // start only from STOPPED
    const address = entry.address ?? `10.0.0.${(this.servers.size % 254) + 1}`;
    entry.state = 'RUNNING';
    entry.address = address;
    entry.uptimeHours = 0;
    if (opts?.machineType !== undefined) entry.machineType = opts.machineType;
    if (opts?.diskType !== undefined) entry.diskType = opts.diskType;
    return { id, address, ...(entry.dnsHost !== undefined ? { dnsHost: entry.dnsHost } : {}) };
  }

  async stop(id: ServerId, opts?: StopOptions): Promise<void> {
    this.record('stop', id, opts);
    this.maybeFail('stop');
    const entry = this.servers.get(id);
    if (!entry || entry.state !== 'RUNNING') {
      // Mirror the real provider's idempotent stop: no live instance reads as
      // success when allowed, else surfaces as a not-found error.
      if (opts?.allowAlreadyStopped) return;
      throw new ServerNotFoundError(id);
    }
    nextState(entry.state, 'stop'); // stop only from RUNNING
    entry.state = 'STOPPED';
    delete entry.address;
    entry.uptimeHours = 0;
    entry.snapshots += 1; // snapshot taken on stop
  }

  async destroy(id: ServerId): Promise<void> {
    this.record('destroy', id);
    this.maybeFail('destroy');
    this.servers.delete(id);
  }

  /**
   * Set/clear the remembered DuckDNS host (CLI retrofit). Concrete, not on the
   * seam — mirrors {@link GcpServerProvider.setDnsHost} so CLI tests can drive it.
   */
  async setDnsHost(id: ServerId, hostname?: string): Promise<void> {
    this.record('setDnsHost', id, hostname);
    const entry = this.require(id);
    if (hostname) entry.dnsHost = hostname;
    else delete entry.dnsHost;
  }

  async status(id: ServerId): Promise<ServerStatus> {
    this.record('status', id);
    this.maybeFail('status');
    const entry = this.require(id);
    return {
      state: entry.state,
      ...(entry.address !== undefined ? { address: entry.address } : {}),
    };
  }

  async list(): Promise<ServerSummary[]> {
    this.record('list');
    this.maybeFail('list');
    return [...this.servers.entries()].map(([id, e]) => ({
      id,
      state: e.state,
      ...(e.address !== undefined ? { address: e.address } : {}),
      ...(e.machineType !== undefined ? { machineType: e.machineType } : {}),
      ...(e.diskType !== undefined ? { diskType: e.diskType } : {}),
      ...(e.dnsHost !== undefined ? { dnsHost: e.dnsHost } : {}),
    }));
  }

  async reconcile(opts: ReconcileOptions): Promise<ReconcileReport> {
    this.record('reconcile', opts);
    this.maybeFail('reconcile');
    const report: ReconcileReport = { warned: [], stopped: [] };
    if (opts.maxUptimeHours <= 0) return report; // disabled

    const autoStop = opts.autoStopUptimeHours ?? 0;
    for (const [id, e] of this.servers.entries()) {
      if (e.state !== 'RUNNING') continue;
      if (e.uptimeHours < opts.maxUptimeHours) continue;
      const stale: StaleServer = { id, uptimeHours: e.uptimeHours };
      if (autoStop > 0 && e.uptimeHours >= autoStop) {
        e.state = 'STOPPED';
        delete e.address;
        e.uptimeHours = 0;
        e.snapshots += 1;
        report.stopped.push(stale);
      } else {
        report.warned.push(stale);
      }
    }
    return report;
  }
}
