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

/** Maps directly onto a GCP custom machine type (e2-custom-VCPUS-MEMORYMB). */
export interface MachineSpec {
  vcpus: number;
  memoryMb: number;
  diskGb: number;
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
