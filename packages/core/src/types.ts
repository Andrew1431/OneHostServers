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

/**
 * A port (or contiguous range) the game needs open. Generic: the user declares
 * these per server. `port` is a GCP firewall port token — a single port
 * (`"25565"`) or an inclusive range (`"15636-15637"`). Discontiguous ports are
 * expressed as separate rules.
 */
export interface PortRule {
  protocol: IpProtocol;
  port: string;
}

/**
 * Optional stable-address config. Opt-in: omit it and the server keeps its bare
 * ephemeral IP (which changes every start). When set, the control plane upserts an
 * A record on each boot and clears it on stop (epic #13). DNS is its own seam
 * (`@onehost/dns`), not part of the cloud provider — `provider` only selects the
 * adapter.
 */
export interface DnsSpec {
  /** Adapter selector. v1 ships only DuckDNS. */
  provider: 'duckdns';
  /**
   * The subdomain *label* the record lives at — `myserver` for
   * `myserver.duckdns.org`, not the full domain. Must be label-safe (lowercase
   * alphanumeric + hyphens) so it survives as a GCP label across stop/start.
   */
  hostname: string;
}

/** Everything needed to provision a server. Immutable user intent. */
export interface ServerSpec {
  id: ServerId;
  ownerDiscordId: string;
  machine: MachineSpec;
  ports: PortRule[];
  region: string;
  /** Optional stable address (opt-in). See {@link DnsSpec}. */
  dns?: DnsSpec;
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
  /** DuckDNS subdomain label this server resolves at, if DNS is enabled. */
  dnsHost?: string;
}

/**
 * A RUNNING server the reconcile sweep flagged for being up too long — the
 * lost-idle-signal backstop / long-running-server nag (issue #18).
 */
export interface StaleServer {
  id: ServerId;
  /** Zone the instance runs in. */
  zone?: string;
  /** Hours since the current run started (lastStart, else creation). */
  uptimeHours: number;
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
  /** DuckDNS subdomain label remembered on the instance/snapshot, if DNS is enabled. */
  dnsHost?: string;
}
