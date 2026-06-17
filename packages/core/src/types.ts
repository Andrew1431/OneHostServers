/**
 * Pure domain types. No I/O, no cloud SDK. Everything the rest of the system
 * agrees on lives here so packages depend on shapes, not on each other's guts.
 */

export type ServerId = string;

export type ServerState =
  | 'STOPPED' // no instance, no disk; only snapshots in object/snapshot storage
  | 'STARTING' // provisioning: restoring disk from snapshot + booting
  | 'RUNNING' // instance up, game process is the user's concern
  | 'STOPPING' // snapshotting disk, then deleting instance + disk
  | 'ERROR'; // a transition failed; needs inspection/reset

/** Compute + disk sizing for a server. */
export interface MachineSpec {
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  /** GCP disk type: pd-standard | pd-balanced | pd-ssd. */
  diskType: string;
  /**
   * Full GCP machine type (e.g. "n2-standard-4", "c2-standard-8"). If unset,
   * derived as `e2-custom-VCPUS-MEMORYMB`. Use this to pick a faster-core family
   * than e2 — which matters more than core count for Minecraft.
   */
  type?: string;
}

export type IpProtocol = 'tcp' | 'udp';

/** A port the game needs open. Generic: the user declares these per server. */
export interface PortRule {
  protocol: IpProtocol;
  port: number;
}

/** Everything needed to provision a server. Immutable user intent. */
export interface ServerSpec {
  id: ServerId;
  ownerDiscordId: string;
  machine: MachineSpec;
  ports: PortRule[];
  region: string;
}

/** Persisted record of a server's current reality. */
export interface ServerRecord {
  spec: ServerSpec;
  state: ServerState;
  /** Public address when RUNNING, otherwise undefined. */
  address?: string;
  updatedAt: string;
}

export interface ServerStatus {
  state: ServerState;
  address?: string;
}

export interface RunningServer {
  id: ServerId;
  address: string;
}

/** One row in a `list` view: a server's reality across all zones, no DB needed. */
export interface ServerSummary {
  id: ServerId;
  state: ServerState;
  /** Zone the live instance sits in; undefined when STOPPED (no instance). */
  zone?: string;
  /** Public address when RUNNING. */
  address?: string;
  /** Sizing remembered on the instance or its latest snapshot, if known. */
  machineType?: string;
  diskType?: string;
}
