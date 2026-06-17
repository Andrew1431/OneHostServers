import type {
  ServerId,
  ServerSpec,
  ServerStatus,
  ServerSummary,
  RunningServer,
} from '@onehost/core';

/**
 * The cloud seam. A provider knows how to turn intent (ServerSpec) into real
 * infrastructure and back. Adding AWS later = one new package implementing this
 * interface; nothing else in the system changes.
 *
 * Implementations must be idempotent-friendly: callers may retry on failure.
 * See docs/SHORTCUTS.md (#5) — full idempotency keys are a future refactor.
 */
/**
 * One-off overrides when starting. If omitted, the provider restores the
 * machine + disk type recorded on the latest snapshot. Setting these *changes*
 * the server going forward (e.g. upgrade onto SSD or a faster-core machine).
 */
export interface StartOptions {
  machineType?: string;
  diskType?: string;
}

export interface ServerProvider {
  /** First-time provision: fresh disk from a base image + boot. */
  create(spec: ServerSpec): Promise<RunningServer>;

  /** Restore the latest snapshot into a disk and boot an instance. */
  start(id: ServerId, opts?: StartOptions): Promise<RunningServer>;

  /** Snapshot the disk, then delete the instance + disk. Idle cost -> snapshots only. */
  stop(id: ServerId): Promise<void>;

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
}

export class ServerNotFoundError extends Error {
  constructor(readonly id: ServerId) {
    super(`Server not found: ${id}`);
    this.name = 'ServerNotFoundError';
  }
}
