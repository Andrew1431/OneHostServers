import type {
  ServerId,
  ServerSpec,
  ServerStatus,
  ServerSummary,
  RunningServer,
  StaleServer,
} from '@onehost/core';

/**
 * The cloud seam. A provider knows how to turn intent (ServerSpec) into real
 * infrastructure and back. Adding AWS later = one new package implementing this
 * interface; nothing else in the system changes.
 *
 * Implementations must be idempotent-friendly: callers may retry on failure.
 * See issue #17 — full idempotency keys are a future refactor.
 */
/**
 * One-off overrides when starting. If omitted, the provider restores the
 * machine + disk type recorded on the latest snapshot. Setting these *changes*
 * the server going forward (e.g. upgrade onto SSD or a faster-core machine).
 */
export interface StartOptions {
  machineType?: string;
  diskType?: string;
  /**
   * Grow the restored boot disk to this many GB. Must be >= the snapshot's
   * size (GCP rejects shrinking). Omit to keep whatever size the snapshot has.
   * The GCE guest auto-grows the root filesystem to fill the disk on boot.
   */
  diskSizeGb?: number;
}

/** One-off overrides when stopping. */
export interface StopOptions {
  /**
   * Treat "no instance to stop" as success instead of throwing. Off by default
   * so an operator typo still errors; on for idle/retried/swept stops where the
   * VM may already be gone (idempotency — see issue #17).
   */
  allowAlreadyStopped?: boolean;
}

/**
 * Thresholds for {@link ServerProvider.reconcile}. Uptime-driven (idleness isn't
 * observable off-box), so this is both the long-running-server nag and the
 * lost-idle-signal backstop: a VM whose self-stop signal was dropped eventually
 * crosses the uptime ceiling and gets caught.
 */
export interface ReconcileOptions {
  /** Flag a RUNNING server once it has been up at least this many hours. <= 0 disables. */
  maxUptimeHours: number;
  /** Also auto-stop once up at least this many hours. Omit / <= 0 = warn only, never stop. */
  autoStopUptimeHours?: number;
}

/** What a single reconcile pass did, for the caller to announce. */
export interface ReconcileReport {
  /** Newly flagged this pass (a dedup marker suppresses re-warning on later passes). */
  warned: StaleServer[];
  /** Auto-stopped this pass because they crossed `autoStopUptimeHours`. */
  stopped: StaleServer[];
}

export interface ServerProvider {
  /** First-time provision: fresh disk from a base image + boot. */
  create(spec: ServerSpec): Promise<RunningServer>;

  /** Restore the latest snapshot into a disk and boot an instance. */
  start(id: ServerId, opts?: StartOptions): Promise<RunningServer>;

  /**
   * Quiesce the guest (graceful OS shutdown), snapshot the disk, then delete the
   * instance + disk. Idle cost -> snapshots only.
   */
  stop(id: ServerId, opts?: StopOptions): Promise<void>;

  /** Delete the instance, disk, and all snapshots. Irreversible. */
  destroy(id: ServerId): Promise<void>;

  /** Best-effort current status from the cloud (source of truth is the provider). */
  status(id: ServerId): Promise<ServerStatus>;

  /**
   * Every server this deployment knows about, across all zones — live instances
   * plus STOPPED servers that exist only as snapshots. The cloud is the source
   * of truth, so this needs no database.
   */
  list(): Promise<ServerSummary[]>;

  /**
   * Sweep RUNNING servers and act on any up past the configured ceiling: flag
   * (once, deduped) and optionally auto-stop. Backstops a lost idle-stop signal
   * so a forgotten VM can't bill forever. Returns what it touched, for the
   * caller to announce (e.g. a channel webhook). See issue #18.
   */
  reconcile(opts: ReconcileOptions): Promise<ReconcileReport>;
}

export class ServerNotFoundError extends Error {
  constructor(readonly id: ServerId) {
    super(`Server not found: ${id}`);
    this.name = 'ServerNotFoundError';
  }
}
