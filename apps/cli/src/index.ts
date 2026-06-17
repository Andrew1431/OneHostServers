#!/usr/bin/env tsx
import type { ServerSpec } from '@onehost/core';
import { GcpServerProvider } from '@onehost/gcp';
import { loadGcpConfig } from './config.ts';

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
  const [command, id, ...rest] = process.argv.slice(2);
  if (!command || command === 'help') return usage();

  const provider = new GcpServerProvider(loadGcpConfig());

  switch (command) {
    case 'create': {
      if (!id) return fail('create needs a server id');
      const spec = buildSpec(id, parseFlags(rest));
      const running = await provider.create(spec);
      console.log(`✅ created '${id}' — reachable at ${running.address}`);
      console.log('   SSH in and install your game, then `stop` to snapshot it.');
      break;
    }
    case 'start': {
      if (!id) return fail('start needs a server id');
      const running = await provider.start(id);
      console.log(`✅ started '${id}' — reachable at ${running.address}`);
      break;
    }
    case 'stop': {
      if (!id) return fail('stop needs a server id');
      await provider.stop(id);
      console.log(`✅ stopped '${id}' — snapshot saved, instance + disk deleted`);
      break;
    }
    case 'status': {
      if (!id) return fail('status needs a server id');
      const status = await provider.status(id);
      console.log(`${id}: ${status.state}${status.address ? ` @ ${status.address}` : ''}`);
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
  ports: ServerSpec['ports'];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { vcpus: 2, memory: 4096, disk: 20, ports: [] };
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
      case '--port': {
        const [protocol, port] = value.split(':');
        if (protocol !== 'tcp' && protocol !== 'udp') return fail(`bad --port: ${value}`);
        flags.ports.push({ protocol, port: Number(port) });
        break;
      }
      default:
        return fail(`unknown flag: ${key}`);
    }
  }
  return flags;
}

function buildSpec(id: string, flags: Flags): ServerSpec {
  return {
    id,
    ownerDiscordId: 'cli',
    region: process.env.GCP_ZONE?.replace(/-[a-z]$/, '') ?? 'us-central1',
    machine: { vcpus: flags.vcpus, memoryMb: flags.memory, diskGb: flags.disk },
    ports: flags.ports,
  };
}

function usage(): void {
  console.log(
    [
      'onehost <command> <server-id> [flags]',
      '',
      '  create <id> [--vcpus 2] [--memory 4096] [--disk 20] [--port tcp:25565]',
      '  start <id>',
      '  stop <id>',
      '  status <id>',
      '  destroy <id>',
      '',
      'env: GCP_PROJECT_ID (required), GCP_ZONE (default us-central1-a)',
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
