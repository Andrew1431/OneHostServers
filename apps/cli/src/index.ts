#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import type { ServerSpec, MachineSpec, ServerSummary } from '@onehost/core';
import { viewServer } from '@onehost/core';
import type { StartOptions, ReconcileOptions } from '@onehost/provider-api';
import { GcpServerProvider } from '@onehost/gcp';
import { loadGcpConfig, writeConfig, envFilePath } from './config.ts';
import { createInteractively, startInteractively } from './interactive.ts';
import { runInit } from './init.ts';

/**
 * Bare-bones CLI to drive the GCP provider directly — your hands-on GCP surface
 * before any Discord/serverless plumbing exists.
 *
 *   pnpm cli create <id> [--vcpus 2] [--memory 4096] [--disk 20] [--port tcp:25565]
 *   pnpm cli start   <id>
 *   pnpm cli stop    <id>
 *   pnpm cli status  <id>
 *   pnpm cli destroy <id>
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, id, ...rest] = args;
  if (!command || command === 'help') return usage();
  if (command === 'config') return runConfig(args.slice(1));
  if (command === 'init') return runInit(); // before loadGcpConfig — writes the .env it would read

  const cfg = loadGcpConfig();
  const provider = new GcpServerProvider(cfg);

  switch (command) {
    case 'create': {
      // Interactive when run in a TTY with no sizing flags, or forced with -i.
      const force = rest.includes('-i') || rest.includes('--interactive');
      const sizingFlags = rest.filter((a) => a !== '-i' && a !== '--interactive');
      if (process.stdin.isTTY && (force || sizingFlags.length === 0)) {
        await createInteractively(provider, { id, cfg });
        break;
      }
      if (!id) return fail('create needs a server id');
      const spec = buildSpec(id, parseFlags(rest));
      const running = await provider.create(spec);
      console.log(`✅ created '${id}' — reachable at ${running.address}`);
      console.log('   SSH in and install your game, then `stop` to snapshot it.');
      break;
    }
    case 'start': {
      if (!id) return fail('start needs a server id');
      // Opt-in picker — plain `start` stays non-interactive and restores the
      // sizing the snapshot remembers (only `--interactive`/`-i` prompts).
      if (rest.includes('-i') || rest.includes('--interactive')) {
        if (!process.stdin.isTTY) return fail('--interactive needs a TTY');
        await startInteractively(provider, { id, cfg });
        break;
      }
      const running = await provider.start(id, parseStartOpts(rest));
      console.log(`✅ started '${id}' — reachable at ${running.address}`);
      break;
    }
    case 'stop': {
      if (!id) return fail('stop needs a server id');
      await provider.stop(id);
      console.log(`✅ stopped '${id}' — snapshot saved, instance + disk deleted`);
      break;
    }
    case 'list': {
      printServers(await provider.list());
      break;
    }
    case 'sweep': {
      // Manual trigger of the reconcile sweep (the worker runs this on Cloud
      // Scheduler's cron). Flags override the ONEHOST_*_UPTIME_HOURS env defaults.
      const opts = parseSweepOpts(rest);
      const report = await provider.reconcile(opts);
      if (report.stopped.length === 0 && report.warned.length === 0) {
        console.log(
          opts.maxUptimeHours <= 0
            ? 'sweep disabled (set --max-uptime <hours> or ONEHOST_MAX_UPTIME_HOURS)'
            : `✅ nothing past ${opts.maxUptimeHours}h`,
        );
        break;
      }
      for (const s of report.stopped) {
        console.log(`⏹  auto-stopped '${s.id}' — up ${Math.floor(s.uptimeHours)}h`);
      }
      for (const s of report.warned) {
        console.log(`⚠️  '${s.id}' up ${Math.floor(s.uptimeHours)}h (flagged)`);
      }
      break;
    }
    case 'status': {
      if (!id) return fail('status needs a server id');
      const status = await provider.status(id);
      console.log(`${id}: ${status.state}${status.address ? ` @ ${status.address}` : ''}`);
      break;
    }
    case 'ssh': {
      if (!id) return fail('ssh needs a server id');
      // Resolve the live instance + its actual zone, then hand off to the user's
      // gcloud (which carries their auth/keys). Anything after the id passes
      // straight through — e.g. `ssh mc -- sudo docker compose logs`.
      const target = await provider.resolveSshTarget(id);
      const result = spawnSync(
        'gcloud',
        ['compute', 'ssh', target.instanceName, '--zone', target.zone, '--project', target.projectId, ...rest],
        { stdio: 'inherit', shell: true },
      );
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail('gcloud not found on PATH — install the Google Cloud SDK to use `ssh`');
        }
        throw result.error;
      }
      process.exit(result.status ?? 0);
    }
    case 'ports': {
      if (!id) return fail('ports needs a server id');
      const ports = parsePorts(rest);
      await provider.setPorts(id, ports);
      if (ports.length === 0) {
        console.log(`✅ '${id}' — firewall rule removed (no game ports open)`);
      } else {
        const list = ports.map((p) => `${p.protocol}:${p.port}`).join(', ');
        console.log(`✅ '${id}' now opens ${list}`);
        console.log('   Running servers apply this live; a stopped one picks it up on next start.');
      }
      break;
    }
    case 'destroy': {
      if (!id) return fail('destroy needs a server id');
      await provider.destroy(id);
      console.log(`✅ destroyed '${id}' — instance, disk, and snapshots deleted`);
      break;
    }
    default:
      return fail(`unknown command: ${command}`);
  }
}

interface Flags {
  vcpus: number;
  memory: number;
  disk: number;
  diskType: string;
  machine?: string;
  ports: ServerSpec['ports'];
}

function parseFlags(args: string[]): Flags {
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
      default:
        return fail(`unknown flag: ${key}`);
    }
  }
  return flags;
}

/** Only includes overrides the user explicitly passed, so a plain `start`
 *  preserves whatever the snapshot remembers. */
function parseStartOpts(args: string[]): StartOptions {
  const opts: StartOptions = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (key === '--machine') opts.machineType = value;
    else if (key === '--disk-type') opts.diskType = value;
    else if (key === '--disk') {
      const gb = Number(value);
      if (!Number.isInteger(gb) || gb <= 0) return fail(`--disk needs a positive integer (GB)`);
      opts.diskSizeGb = gb;
    } else return fail(`unknown flag: ${key}`);
  }
  return opts;
}

/** Parse `--port tcp:25565` flags for the `ports` command. No ports => clear the rule. */
function parsePorts(args: string[]): ServerSpec['ports'] {
  const ports: ServerSpec['ports'] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (key !== '--port') return fail(`unknown flag: ${key}`);
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
function parsePortFlag(value: string): ServerSpec['ports'] {
  const [protocol, spec] = value.split(':');
  if (protocol !== 'tcp' && protocol !== 'udp') return fail(`bad --port: ${value} (want tcp:… or udp:…)`);
  if (!spec) return fail(`bad --port: ${value} (missing port)`);
  return spec.split(',').map((token) => {
    if (!/^\d+(-\d+)?$/.test(token)) return fail(`bad --port: '${token}' in ${value} (use N or N-M)`);
    const bounds = token.split('-').map(Number);
    if (bounds.some((n) => n < 1 || n > 65535)) return fail(`port out of range in ${value} (1-65535)`);
    if (bounds.length === 2 && bounds[0]! > bounds[1]!) return fail(`reversed range in ${value}`);
    return { protocol, port: token };
  });
}

/** Sweep thresholds: flags win, else the ONEHOST_*_UPTIME_HOURS env, else off. */
function parseSweepOpts(args: string[]): ReconcileOptions {
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
    else return fail(`unknown flag: ${key}`);
  }
  if (Number.isNaN(opts.maxUptimeHours) || Number.isNaN(opts.autoStopUptimeHours ?? 0)) {
    return fail('--max-uptime / --autostop need a number of hours');
  }
  return opts;
}

function buildSpec(id: string, flags: Flags): ServerSpec {
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
  };
}

/** `config --project <id> [--zone <zone>]` — persist to the repo-root `.env`. */
function runConfig(args: string[]): void {
  const updates: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (key === '--project') updates.GCP_PROJECT_ID = value;
    else if (key === '--zone') updates.GCP_ZONE = value;
    else if (key === '--keep-snapshots') {
      if (!Number.isInteger(Number(value))) return fail(`--keep-snapshots needs an integer`);
      updates.ONEHOST_SNAPSHOT_KEEP = value;
    } else return fail(`unknown config flag: ${key}`);
  }
  if (Object.keys(updates).length === 0) {
    return fail('config needs --project <id>, --zone <zone>, and/or --keep-snapshots <n>');
  }
  const path = writeConfig(updates);
  console.log(`✅ saved to ${path}`);
  for (const [k, v] of Object.entries(updates)) console.log(`   ${k}=${v}`);
}

function printServers(servers: ServerSummary[]): void {
  if (servers.length === 0) {
    console.log('No servers. `create <id>` to make one.');
    return;
  }
  const rows = servers.map((s) => {
    const v = viewServer(s);
    return {
      ID: v.id,
      STATE: v.state,
      ZONE: v.zone,
      ADDRESS: v.address,
      MACHINE: v.machine,
      DISK: v.disk,
    };
  });
  const cols = Object.keys(rows[0]!) as Array<keyof (typeof rows)[number]>;
  const width = (c: keyof (typeof rows)[number]) =>
    Math.max(c.length, ...rows.map((r) => r[c].length));
  const line = (r: Record<string, string>) =>
    cols.map((c) => r[c]!.padEnd(width(c))).join('  ');
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  for (const r of rows) console.log(line(r));
}

function usage(): void {
  console.log(
    [
      'onehost <command> <server-id> [flags]',
      '',
      '  init                                                         # first-run setup: writes .env + terraform.tfvars',
      '  create [<id>]                                                # interactive picker (TTY)',
      '  create <id> [--vcpus 2] [--memory 4096] [--disk 20]         # non-interactive',
      '              [--disk-type pd-balanced] [--machine n2-standard-4] [--port tcp:25565]',
      '              [-i|--interactive]                               # force the picker',
      '  start <id>  [--disk-type pd-ssd] [--machine c2-standard-4]   # override to upgrade',
      '              [--disk 40]                                      # grow boot disk (GB, >= snapshot)',
      '              [-i|--interactive]                               # pick machine/disk override from a menu',
      '  stop <id>',
      '  status <id>',
      '  ports <id> [--port udp:15636-15637] [--port tcp:80,443]      # set open ports (CLI-only); ranges N-M and lists N,M ok; no --port clears them',
      '  ssh <id> [-- <remote command>]                               # gcloud compute ssh into it',
      '  list                                                         # all servers, all zones',
      '  sweep [--max-uptime <h>] [--autostop <h>]                    # flag/auto-stop long-running servers',
      '  destroy <id>',
      '  config --project <id> [--zone <zone>] [--keep-snapshots 3]   # save to .env once',
      '',
      '  --machine overrides --vcpus/--memory (pick a faster-core family than e2)',
      '  disk types: pd-standard (HDD) | pd-balanced (SSD) | pd-ssd (fast SSD)',
      '',
      'config: GCP_PROJECT_ID (required), GCP_ZONE (default us-central1-a) —',
      '        read from env or the repo-root .env (run `config` to write it).',
    ].join('\n'),
  );
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
