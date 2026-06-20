import * as p from '@clack/prompts';
import type { ServerSpec } from '@onehost/core';
import type { ServerProvider, StartOptions } from '@onehost/provider-api';
import { dnsProviderFromEnv } from '@onehost/dns';
import {
  GcpCatalog,
  type GcpConfig,
  type MachineTypeInfo,
  estimate,
  machineHourly,
  diskHourly,
  fmtHr,
  HOURS_PER_MONTH,
  PRICED_REGION,
} from '@onehost/gcp';
import { parseDnsHost, UsageError } from './parse.ts';

/**
 * Curated machine families ordered by gaming "power level". Cost and core count
 * aren't the same thing for games — single-core clock is what most game loops
 * lean on — so the blurbs describe felt performance, not vCPU count. Only
 * families actually offered in the chosen zone are shown.
 */
const FAMILY_TIERS: Array<{
  family: string;
  tier: string;
  blurb: string;
  /** Custom <family>-custom-V-M sizing is offered for these (proven formula). */
  custom: boolean;
}> = [
  { family: 'e2', tier: 'Entry', blurb: 'cheapest dedicated cores, lower clock — few players / light load', custom: true },
  { family: 'n2', tier: 'Standard', blurb: 'steady dedicated Intel cores — the dependable middle', custom: true },
  { family: 'n2d', tier: 'Standard', blurb: 'steady AMD cores, a little cheaper than n2', custom: true },
  { family: 'c2d', tier: 'High', blurb: 'compute-tuned AMD; strong sustained per-core', custom: false },
  { family: 'c3', tier: 'Top', blurb: 'newer Intel; high single-core clock', custom: false },
  { family: 'c4', tier: 'Top', blurb: 'newest Intel; best single-core clock — heaviest load', custom: false },
];

const RAM_RATIOS = [
  { label: 'Light — 1 GB / vCPU', perVcpuGb: 1 },
  { label: 'Standard — 2 GB / vCPU', perVcpuGb: 2 },
  { label: 'High — 4 GB / vCPU', perVcpuGb: 4 },
];
const VCPU_CHOICES = [2, 4, 8, 16];

const DISK_BLURBS: Record<string, string> = {
  'pd-standard': 'HDD — cheapest, slow random I/O',
  'pd-balanced': 'Balanced SSD — good default',
  'pd-ssd': 'Performance SSD — fastest',
  'pd-extreme': 'Extreme SSD — provisioned IOPS',
  'hyperdisk-balanced': 'Hyperdisk — newer balanced SSD',
};

function cancelled<T>(v: T | symbol): v is symbol {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.');
    return true;
  }
  return false;
}

/** Region's price-estimate caveat, shown once at the top of each flow. */
function priceCaveat(region: string): void {
  if (region !== PRICED_REGION) {
    p.log.warn(
      `Price estimates are for ${PRICED_REGION}; this deployment is ${region}, so costs are approximate.`,
    );
  }
}

/**
 * Load the zone's machine + disk options, grouped by family (shared-core types
 * dropped — they're throttled/bursty, poor for game loops, and priced specially).
 * Returns null if the user has nothing to pick from.
 */
async function loadOptions(
  cfg: GcpConfig,
): Promise<{ byFamily: Map<string, MachineTypeInfo[]>; diskTypes: string[] }> {
  const catalog = new GcpCatalog(cfg);
  const spin = p.spinner();
  spin.start(`Loading machine + disk options for ${cfg.zone}`);
  let machineTypes: MachineTypeInfo[];
  let diskTypes: string[];
  try {
    [machineTypes, diskTypes] = await Promise.all([
      catalog.listMachineTypes(),
      catalog.listDiskTypes(),
    ]);
    spin.stop(`Loaded options for ${cfg.zone}`);
  } catch (err) {
    spin.stop('Failed to load options', 1);
    throw err;
  }
  const byFamily = new Map<string, MachineTypeInfo[]>();
  for (const mt of machineTypes) {
    if (mt.sharedCpu) continue;
    (byFamily.get(mt.family) ?? byFamily.set(mt.family, []).get(mt.family)!).push(mt);
  }
  return { byFamily, diskTypes };
}

/**
 * Pick a machine: family power tier, then a predefined size or the custom
 * vCPU/RAM formula. Returns null on cancel.
 */
async function selectMachine(
  byFamily: Map<string, MachineTypeInfo[]>,
): Promise<{ machineType: string; vcpus: number; memoryMb: number } | null> {
  const tiers = FAMILY_TIERS.filter((t) => byFamily.has(t.family));
  if (tiers.length === 0) throw new Error('No known machine families available in this zone.');
  const familyChoice = await p.select({
    message: 'Machine power tier',
    options: tiers.map((t) => {
      const cheapest = byFamily.get(t.family)![0]!;
      const from = machineHourly(cheapest.name, cheapest.vcpus, cheapest.memoryMb);
      return {
        value: t.family,
        label: `${t.tier} · ${t.family} — from ${fmtHr(from)}`,
        hint: t.blurb,
      };
    }),
  });
  if (cancelled(familyChoice)) return null;
  const tier = tiers.find((t) => t.family === familyChoice)!;

  const sizeOptions: Array<{ value: string; label: string; hint?: string }> = [];
  if (tier.custom) {
    sizeOptions.push({ value: '__custom__', label: 'Custom — pick vCPUs + RAM', hint: 'exact sizing' });
  }
  for (const mt of byFamily.get(tier.family)!) {
    if (mt.vcpus > 32) continue; // keep the list gaming-relevant
    const hr = machineHourly(mt.name, mt.vcpus, mt.memoryMb);
    sizeOptions.push({
      value: mt.name,
      label: `${mt.name} — ${mt.vcpus} vCPU / ${(mt.memoryMb / 1024).toFixed(0)} GB · ${fmtHr(hr)}`,
    });
  }

  const sizeChoice = await p.select({ message: `${tier.family} size`, options: sizeOptions });
  if (cancelled(sizeChoice)) return null;

  if (sizeChoice === '__custom__') {
    const vc = await p.select({
      message: 'vCPUs',
      options: VCPU_CHOICES.map((n) => ({ value: String(n), label: `${n} vCPU` })),
    });
    if (cancelled(vc)) return null;
    const vcpus = Number(vc);
    const ratioChoice = await p.select({
      message: 'RAM',
      options: RAM_RATIOS.map((r) => {
        const mb = vcpus * r.perVcpuGb * 1024;
        const hr = machineHourly(`${tier.family}-custom-${vcpus}-${mb}`, vcpus, mb);
        return { value: String(r.perVcpuGb), label: `${r.label} = ${vcpus * r.perVcpuGb} GB · ${fmtHr(hr)}` };
      }),
    });
    if (cancelled(ratioChoice)) return null;
    const memoryMb = vcpus * Number(ratioChoice) * 1024;
    return { machineType: `${tier.family}-custom-${vcpus}-${memoryMb}`, vcpus, memoryMb };
  }
  const mt = byFamily.get(tier.family)!.find((m) => m.name === sizeChoice)!;
  return { machineType: mt.name, vcpus: mt.vcpus, memoryMb: mt.memoryMb };
}

/** Pick a disk type with price + blurb. Returns null on cancel. */
async function selectDiskType(diskTypes: string[]): Promise<string | null> {
  const known = diskTypes.filter((d) => d in DISK_BLURBS);
  const diskList = known.length > 0 ? known : diskTypes;
  const defaultDisk = diskList.includes('pd-balanced') ? 'pd-balanced' : (diskList[0] ?? 'pd-balanced');
  const diskChoice = await p.select<string>({
    message: 'Disk type',
    initialValue: defaultDisk,
    options: diskList.map((d) => {
      const perGbMo = diskHourly(d, 1);
      const price = perGbMo === undefined ? '' : ` · ~$${(perGbMo * HOURS_PER_MONTH).toFixed(3)}/GB-mo`;
      const blurb = DISK_BLURBS[d];
      return { value: d, label: `${d}${price}`, ...(blurb ? { hint: blurb } : {}) };
    }),
  });
  if (cancelled(diskChoice)) return null;
  return diskChoice;
}

/** Prompt a whole-GB disk size (>= 10). Returns null on cancel. */
async function selectDiskSize(): Promise<number | null> {
  const diskAnswer = await p.text({
    message: 'Disk size (GB)',
    placeholder: '20',
    defaultValue: '20',
    validate: (v) => {
      const n = Number(v || '20');
      if (!Number.isInteger(n) || n < 10) return 'Enter a whole number of GB, at least 10';
      return undefined;
    },
  });
  if (cancelled(diskAnswer)) return null;
  return Number(diskAnswer || '20');
}

/**
 * Validate a free-text ports entry: whitespace-separated `proto:spec` tokens,
 * where spec is a comma list of single ports / `N-M` ranges (e.g.
 * `tcp:25565 udp:15636-15637,27015`). Blank = no ports. Returns an error string
 * (for clack's validate) or undefined when valid.
 */
export function validatePortsInput(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  for (const entry of raw.trim().split(/\s+/)) {
    const [proto, spec] = entry.split(':');
    if (proto !== 'tcp' && proto !== 'udp') return `'${entry}': start with tcp: or udp:`;
    if (!spec) return `'${entry}': missing port`;
    for (const tok of spec.split(',')) {
      if (!/^\d+(-\d+)?$/.test(tok)) return `'${tok}': use N or N-M`;
      const bounds = tok.split('-').map(Number);
      if (bounds.some((n) => n < 1 || n > 65535)) return `'${entry}': ports are 1-65535`;
      if (bounds.length === 2 && bounds[0]! > bounds[1]!) return `'${entry}': reversed range`;
    }
  }
  return undefined;
}

/** Parse a ports entry already passed {@link validatePortsInput}. */
export function parsePortsInput(raw: string): ServerSpec['ports'] {
  const ports: ServerSpec['ports'] = [];
  if (!raw.trim()) return ports;
  for (const entry of raw.trim().split(/\s+/)) {
    const [proto, spec] = entry.split(':');
    for (const tok of spec!.split(',')) ports.push({ protocol: proto as 'tcp' | 'udp', port: tok });
  }
  return ports;
}

/** Clack validator for the optional DuckDNS hostname (blank = none). */
export function validateDnsInput(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    parseDnsHost(raw.trim());
    return undefined;
  } catch (err) {
    return err instanceof UsageError ? err.message.replace(/^bad --dns: /, '') : 'invalid hostname';
  }
}

/**
 * Publish a freshly-created server's A record, best-effort. Mirrors the
 * non-interactive `announceDns` in index.ts; lives here so the interactive flow
 * doesn't reach back into the command module.
 */
async function publishDns(host: string, ip: string): Promise<void> {
  const dns = await dnsProviderFromEnv();
  if (!dns) {
    p.log.warn(`DNS: ${host}.duckdns.org — set DUCKDNS_TOKEN to publish the record`);
    return;
  }
  try {
    await dns.upsertAddress(host, ip);
  } catch (err) {
    p.log.warn(`DNS: updating ${host}.duckdns.org failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Interactive `create`: pick machine + disk from live GCP lists with gaming
 * power-tier blurbs and on-demand cost estimates, declare open ports, confirm,
 * then provision. Returns without creating if the user cancels or declines.
 */
export async function createInteractively(
  provider: ServerProvider,
  opts: { id: string | undefined; cfg: GcpConfig },
): Promise<void> {
  const { cfg } = opts;
  const region = cfg.zone.replace(/-[a-z]$/, '');

  p.intro('OneHost — create a server');
  priceCaveat(region);

  // --- server id -------------------------------------------------------------
  let id = opts.id;
  if (!id) {
    const answer = await p.text({
      message: 'Server id',
      placeholder: 'e.g. valheim, mc-survival',
      validate: (v) => (v.trim() ? undefined : 'Required'),
    });
    if (cancelled(answer)) return;
    id = answer.trim();
  }

  const { byFamily, diskTypes } = await loadOptions(cfg);

  const machine = await selectMachine(byFamily);
  if (machine === null) return;
  const { machineType, vcpus, memoryMb } = machine;

  const diskType = await selectDiskType(diskTypes);
  if (diskType === null) return;

  const diskGb = await selectDiskSize();
  if (diskGb === null) return;

  // --- ports -----------------------------------------------------------------
  // Per-server firewall: these open only on THIS server (provider creates an
  // onehost-game-<id> rule). Blank = nothing open but SSH.
  const portsAnswer = await p.text({
    message: 'Open ports',
    placeholder: 'e.g. tcp:25565   udp:15636-15637   (space-separated; blank = none)',
    defaultValue: '',
    validate: validatePortsInput,
  });
  if (cancelled(portsAnswer)) return;
  const ports = parsePortsInput(portsAnswer);

  // --- stable address (opt-in) ----------------------------------------------
  // A DuckDNS subdomain that follows the server's IP across stop/start. Blank to
  // keep the bare ephemeral IP (which changes every start).
  const dnsAnswer = await p.text({
    message: 'Stable address (DuckDNS subdomain, optional)',
    placeholder: 'e.g. my-mc  →  my-mc.duckdns.org   (blank = none)',
    defaultValue: '',
    validate: validateDnsInput,
  });
  if (cancelled(dnsAnswer)) return;
  const dnsHost = dnsAnswer.trim() ? parseDnsHost(dnsAnswer.trim()) : undefined;

  // --- summary + confirm -----------------------------------------------------
  const est = estimate({ region, machineType, vcpus, memoryMb, diskType, diskGb });
  const monthly = est.monthlyTotal === undefined ? '?' : `~$${est.monthlyTotal.toFixed(0)}/mo`;
  p.note(
    [
      `id        ${id}`,
      `machine   ${machineType}  (${vcpus} vCPU / ${(memoryMb / 1024).toFixed(0)} GB)`,
      `disk      ${diskGb} GB ${diskType}`,
      `ports     ${ports.length ? ports.map((pr) => `${pr.protocol}:${pr.port}`).join(', ') : '(none — SSH only)'}`,
      `dns       ${dnsHost ? `${dnsHost}.duckdns.org` : '(none — bare IP)'}`,
      `compute   ${fmtHr(est.computeHr)}`,
      `disk      ${fmtHr(est.diskHr)}`,
      `total     ${fmtHr(est.totalHr)}  (${monthly} if left running)`,
    ].join('\n'),
    'Review',
  );

  const go = await p.confirm({ message: `Create '${id}' now?`, initialValue: true });
  if (cancelled(go) || go === false) {
    if (go === false) p.cancel('Not created.');
    return;
  }

  const spec: ServerSpec = {
    id,
    ownerDiscordId: 'cli',
    region,
    machine: { vcpus, memoryMb, diskGb, diskType, type: machineType },
    ports,
    ...(dnsHost ? { dns: { provider: 'duckdns' as const, hostname: dnsHost } } : {}),
  };

  const create = p.spinner();
  create.start(`Provisioning '${id}'`);
  try {
    const running = await provider.create(spec);
    create.stop(`Created '${id}'`);
    // create boots to RUNNING, so publish the first A record now (best-effort).
    if (running.dnsHost) await publishDns(running.dnsHost, running.address);
    const where = running.dnsHost ? `${running.dnsHost}.duckdns.org (${running.address})` : running.address;
    p.outro(`Reachable at ${where} — SSH in, install your game, then \`stop\` to snapshot it.`);
  } catch (err) {
    create.stop('Provisioning failed', 1);
    throw err;
  }
}

/**
 * Interactive `start` (opt-in via `start <id> --interactive`): restore a server
 * but pick a machine/disk override from the same tiered picker, instead of
 * remembering the exact `--machine` string. Leaving either unchanged restores
 * whatever the snapshot remembers — same as a plain `start`.
 */
export async function startInteractively(
  provider: ServerProvider,
  opts: { id: string; cfg: GcpConfig },
): Promise<void> {
  const { id, cfg } = opts;
  const region = cfg.zone.replace(/-[a-z]$/, '');

  p.intro(`OneHost — start '${id}'`);
  priceCaveat(region);

  const summary = (await provider.list()).find((s) => s.id === id);
  if (summary === undefined) {
    p.cancel(`No server '${id}' found — create it first.`);
    return;
  }

  const { byFamily, diskTypes } = await loadOptions(cfg);
  const startOpts: StartOptions = {};

  const changeMachine = await p.confirm({
    message: `Machine: ${summary.machineType ?? 'snapshot default'} — change tier?`,
    initialValue: false,
  });
  if (cancelled(changeMachine)) return;
  if (changeMachine === true) {
    const machine = await selectMachine(byFamily);
    if (machine === null) return;
    startOpts.machineType = machine.machineType;
  }

  const changeDisk = await p.confirm({
    message: `Disk type: ${summary.diskType ?? 'snapshot default'} — change?`,
    initialValue: false,
  });
  if (cancelled(changeDisk)) return;
  if (changeDisk === true) {
    const disk = await selectDiskType(diskTypes);
    if (disk === null) return;
    startOpts.diskType = disk;
  }

  const machineLabel = startOpts.machineType ?? summary.machineType ?? 'snapshot default';
  const diskLabel = startOpts.diskType ?? summary.diskType ?? 'snapshot default';
  p.note(
    [
      `id       ${id}`,
      `machine  ${machineLabel}${startOpts.machineType ? '  (override)' : ''}`,
      `disk     ${diskLabel}${startOpts.diskType ? '  (override)' : ''}`,
    ].join('\n'),
    'Review',
  );

  const go = await p.confirm({ message: `Start '${id}' now?`, initialValue: true });
  if (cancelled(go) || go === false) {
    if (go === false) p.cancel('Not started.');
    return;
  }

  const spin = p.spinner();
  spin.start(`Starting '${id}'`);
  try {
    const running = await provider.start(id, startOpts);
    spin.stop(`Started '${id}'`);
    p.outro(`Reachable at ${running.address}`);
  } catch (err) {
    spin.stop('Start failed', 1);
    throw err;
  }
}
