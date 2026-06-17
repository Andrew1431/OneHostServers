/**
 * Presentation-neutral rendering of server state. Both adapters depend on this
 * so the CLI and the Discord bot can't drift on how a server reads: the CLI
 * builds its table from {@link ServerView}, the worker builds Discord embeds from
 * the same view. Nothing here knows about Discord or a terminal.
 */
import type { ServerState, ServerSummary } from './types.ts';

export const STATE_ICON: Record<ServerState, string> = {
  STOPPED: '⚪',
  STARTING: '🟡',
  RUNNING: '🟢',
  STOPPING: '🟡',
  ERROR: '🔴',
};

/**
 * Read vCPU/RAM straight from a GCP machine-type *name* — no API call, so it's
 * an estimate, not authoritative. Exact for `*-custom-VCPUS-MEMMB`; for
 * predefined types it assumes the standard per-core memory of the e2/n2/c2
 * families (4 GB standard, 8 GB highmem, 1 GB highcpu per vCPU) — close for those,
 * off for n1 (3.75 GB/vCPU). Returns only what it can read.
 */
export function parseMachineType(type: string | undefined): {
  vcpus?: number;
  memoryMb?: number;
} {
  if (!type) return {};

  // Custom types encode it exactly: e2-custom-2-4096, n2-custom-4-8192[-ext].
  const custom = /-custom-(\d+)-(\d+)/.exec(type);
  if (custom) return { vcpus: Number(custom[1]), memoryMb: Number(custom[2]) };

  // Shared-core e2 types don't follow the -<class>-<n> shape.
  const shared: Record<string, { vcpus: number; memoryMb: number }> = {
    micro: { vcpus: 2, memoryMb: 1024 },
    small: { vcpus: 2, memoryMb: 2048 },
    medium: { vcpus: 2, memoryMb: 4096 },
  };
  const sharedKey = /-(micro|small|medium)$/.exec(type)?.[1];
  if (sharedKey && shared[sharedKey]) return shared[sharedKey];

  // Predefined: <family>-<class>-<vcpus>; memory = vcpus * per-core(class).
  const predefined = /-(standard|highmem|highcpu)-(\d+)$/.exec(type);
  if (predefined) {
    const vcpus = Number(predefined[2]);
    const perCoreMb: Record<string, number> = {
      standard: 4096,
      highmem: 8192,
      highcpu: 1024,
    };
    return { vcpus, memoryMb: vcpus * (perCoreMb[predefined[1]!] ?? 4096) };
  }

  return {};
}

/** "4096" -> "4 GB", "3072" -> "3 GB", "1536" -> "1.5 GB". */
export function formatMemory(memoryMb: number | undefined): string | undefined {
  if (memoryMb === undefined) return undefined;
  const gb = memoryMb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** One-line machine description, e.g. "e2-standard-2 · 2 vCPU · 8 GB". */
export function describeMachine(machineType: string | undefined): string {
  if (!machineType) return '—';
  const { vcpus, memoryMb } = parseMachineType(machineType);
  const parts = [machineType];
  if (vcpus !== undefined) parts.push(`${vcpus} vCPU`);
  const mem = formatMemory(memoryMb);
  if (mem) parts.push(mem);
  return parts.join(' · ');
}

/** Normalized, display-ready strings for one server. Built once, rendered many ways. */
export interface ServerView {
  id: string;
  state: ServerState;
  icon: string;
  zone: string;
  address: string;
  machine: string;
  disk: string;
}

export function viewServer(s: ServerSummary): ServerView {
  return {
    id: s.id,
    state: s.state,
    icon: STATE_ICON[s.state],
    zone: s.zone ?? '—',
    address: s.address ?? (s.state === 'RUNNING' ? '(no address)' : '—'),
    machine: describeMachine(s.machineType),
    disk: s.diskType ?? '—',
  };
}

/** Plain-text server list (terminal / non-embed contexts). */
export function formatServerList(servers: ServerSummary[]): string {
  if (servers.length === 0) return 'No servers yet.';
  return servers
    .map((s) => {
      const v = viewServer(s);
      return `${v.icon} ${v.id} · ${v.state} · ${v.machine} · ${v.address}`;
    })
    .join('\n');
}
