import type { ServerSpec, MachineSpec } from '@onehost/core';
import type { StartOptions, ReconcileOptions } from '@onehost/provider-api';

/**
 * Thrown by the pure arg-parsers on bad user input. `index.ts` catches it and
 * converts it to the CLI's `✗ <message>` + exit(1) behavior — keeping the
 * parsers side-effect-free (and so testable in-process) while leaving the
 * user-facing behavior unchanged.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface Flags {
  vcpus: number;
  memory: number;
  disk: number;
  diskType: string;
  machine?: string;
  ports: ServerSpec['ports'];
  /** DuckDNS subdomain label, if `--dns` was passed (opt-in stable address). */
  dns?: string;
}

/**
 * Validate + normalize a DuckDNS hostname into its bare subdomain label. Accepts
 * either `myserver` or the full `myserver.duckdns.org` (the suffix is stripped).
 * The label must be RFC1035 (lowercase alphanumeric + internal hyphens, ≤63) so it
 * round-trips as a GCP label across stop/start.
 */
export function parseDnsHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.duckdns\.org$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(host) || host.length > 63) {
    throw new UsageError(
      `bad --dns: '${value}' (use a DuckDNS subdomain like 'myserver', lowercase letters/digits/hyphens)`,
    );
  }
  return host;
}

export function parseFlags(args: string[]): Flags {
  const flags: Flags = { vcpus: 2, memory: 4096, disk: 20, diskType: 'pd-balanced', ports: [] };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    switch (key) {
      case '--vcpus':
        flags.vcpus = Number(value);
        break;
      case '--memory':
        flags.memory = Number(value);
        break;
      case '--disk':
        flags.disk = Number(value);
        break;
      case '--disk-type':
        flags.diskType = value;
        break;
      case '--machine':
        flags.machine = value;
        break;
      case '--port':
        flags.ports.push(...parsePortFlag(value));
        break;
      case '--dns':
        flags.dns = parseDnsHost(value);
        break;
      default:
        throw new UsageError(`unknown flag: ${key}`);
    }
  }
  return flags;
}

/** Only includes overrides the user explicitly passed, so a plain `start`
 *  preserves whatever the snapshot remembers. */
export function parseStartOpts(args: string[]): StartOptions {
  const opts: StartOptions = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (key === '--machine') opts.machineType = value;
    else if (key === '--disk-type') opts.diskType = value;
    else if (key === '--disk') {
      const gb = Number(value);
      if (!Number.isInteger(gb) || gb <= 0)
        throw new UsageError(`--disk needs a positive integer (GB)`);
      opts.diskSizeGb = gb;
    } else throw new UsageError(`unknown flag: ${key}`);
  }
  return opts;
}

/** Parse `--port tcp:25565` flags for the `ports` command. No ports => clear the rule. */
export function parsePorts(args: string[]): ServerSpec['ports'] {
  const ports: ServerSpec['ports'] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (key !== '--port') throw new UsageError(`unknown flag: ${key}`);
    ports.push(...parsePortFlag(value));
  }
  return ports;
}

/**
 * Parse one `--port` value into rules. Accepts `proto:spec` where spec is a
 * comma-separated list of single ports and/or inclusive ranges:
 *   tcp:25565            tcp:80,443            udp:15636-15637,27015
 * Each list item becomes its own rule (GCP firewall port tokens are 1:1 with these).
 */
export function parsePortFlag(value: string): ServerSpec['ports'] {
  const [protocol, spec] = value.split(':');
  if (protocol !== 'tcp' && protocol !== 'udp')
    throw new UsageError(`bad --port: ${value} (want tcp:… or udp:…)`);
  if (!spec) throw new UsageError(`bad --port: ${value} (missing port)`);
  return spec.split(',').map((token) => {
    if (!/^\d+(-\d+)?$/.test(token))
      throw new UsageError(`bad --port: '${token}' in ${value} (use N or N-M)`);
    const bounds = token.split('-').map(Number);
    if (bounds.some((n) => n < 1 || n > 65535))
      throw new UsageError(`port out of range in ${value} (1-65535)`);
    if (bounds.length === 2 && bounds[0]! > bounds[1]!)
      throw new UsageError(`reversed range in ${value}`);
    return { protocol, port: token };
  });
}

/** Sweep thresholds: flags win, else the ONEHOST_*_UPTIME_HOURS env, else off. */
export function parseSweepOpts(args: string[]): ReconcileOptions {
  const opts: ReconcileOptions = {
    maxUptimeHours: Number(process.env.ONEHOST_MAX_UPTIME_HOURS ?? 0),
    autoStopUptimeHours: Number(process.env.ONEHOST_AUTOSTOP_UPTIME_HOURS ?? 0),
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (key === '--max-uptime') opts.maxUptimeHours = Number(value);
    else if (key === '--autostop') opts.autoStopUptimeHours = Number(value);
    else throw new UsageError(`unknown flag: ${key}`);
  }
  if (Number.isNaN(opts.maxUptimeHours) || Number.isNaN(opts.autoStopUptimeHours ?? 0)) {
    throw new UsageError('--max-uptime / --autostop need a number of hours');
  }
  return opts;
}

export function buildSpec(id: string, flags: Flags): ServerSpec {
  const machine: MachineSpec = {
    vcpus: flags.vcpus,
    memoryMb: flags.memory,
    diskGb: flags.disk,
    diskType: flags.diskType,
    ...(flags.machine ? { type: flags.machine } : {}),
  };
  return {
    id,
    ownerDiscordId: 'cli',
    region: process.env.GCP_ZONE?.replace(/-[a-z]$/, '') ?? 'us-central1',
    machine,
    ports: flags.ports,
    ...(flags.dns ? { dns: { provider: 'duckdns' as const, hostname: flags.dns } } : {}),
  };
}
