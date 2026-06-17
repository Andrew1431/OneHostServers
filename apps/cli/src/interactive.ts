import * as p from '@clack/prompts';
import type { ServerSpec } from '@onehost/core';
import type { ServerProvider } from '@onehost/provider-api';
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
    p.cancel('Cancelled — nothing was created.');
    return true;
  }
  return false;
}

/**
 * Interactive `create`: pick machine + disk from live GCP lists with gaming
 * power-tier blurbs and on-demand cost estimates, confirm, then provision.
 * Returns without creating if the user cancels or declines the summary.
 */
export async function createInteractively(
  provider: ServerProvider,
  opts: { id: string | undefined; cfg: GcpConfig },
): Promise<void> {
  const { cfg } = opts;
  const region = cfg.zone.replace(/-[a-z]$/, '');
  const catalog = new GcpCatalog(cfg);

  p.intro('OneHost — create a server');
  if (region !== PRICED_REGION) {
    p.log.warn(
      `Price estimates are for ${PRICED_REGION}; this deployment is ${region}, so costs are approximate.`,
    );
  }

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

  // --- load what the zone actually offers ------------------------------------
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

  // Skip shared-core types (e2-micro/small/medium): they're throttled/bursty —
  // poor for game loops — and have special flat pricing the per-vCPU rate misses.
  const byFamily = new Map<string, MachineTypeInfo[]>();
  for (const mt of machineTypes) {
    if (mt.sharedCpu) continue;
    (byFamily.get(mt.family) ?? byFamily.set(mt.family, []).get(mt.family)!).push(mt);
  }

  // --- machine family (power tier) -------------------------------------------
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
  if (cancelled(familyChoice)) return;
  const tier = tiers.find((t) => t.family === familyChoice)!;

  // --- size: custom (formula) or a predefined type ---------------------------
  let machineType: string;
  let vcpus: number;
  let memoryMb: number;

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
  if (cancelled(sizeChoice)) return;

  if (sizeChoice === '__custom__') {
    const vc = await p.select({
      message: 'vCPUs',
      options: VCPU_CHOICES.map((n) => ({ value: String(n), label: `${n} vCPU` })),
    });
    if (cancelled(vc)) return;
    vcpus = Number(vc);
    const ratioChoice = await p.select({
      message: 'RAM',
      options: RAM_RATIOS.map((r) => {
        const mb = vcpus * r.perVcpuGb * 1024;
        const hr = machineHourly(`${tier.family}-custom-${vcpus}-${mb}`, vcpus, mb);
        return { value: String(r.perVcpuGb), label: `${r.label} = ${vcpus * r.perVcpuGb} GB · ${fmtHr(hr)}` };
      }),
    });
    if (cancelled(ratioChoice)) return;
    memoryMb = vcpus * Number(ratioChoice) * 1024;
    machineType = `${tier.family}-custom-${vcpus}-${memoryMb}`;
  } else {
    const mt = byFamily.get(tier.family)!.find((m) => m.name === sizeChoice)!;
    machineType = mt.name;
    vcpus = mt.vcpus;
    memoryMb = mt.memoryMb;
  }

  // --- disk type -------------------------------------------------------------
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
  if (cancelled(diskChoice)) return;
  const diskType = diskChoice;

  // --- disk size -------------------------------------------------------------
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
  if (cancelled(diskAnswer)) return;
  const diskGb = Number(diskAnswer || '20');

  // --- summary + confirm -----------------------------------------------------
  const est = estimate({ region, machineType, vcpus, memoryMb, diskType, diskGb });
  const monthly = est.monthlyTotal === undefined ? '?' : `~$${est.monthlyTotal.toFixed(0)}/mo`;
  p.note(
    [
      `id        ${id}`,
      `machine   ${machineType}  (${vcpus} vCPU / ${(memoryMb / 1024).toFixed(0)} GB)`,
      `disk      ${diskGb} GB ${diskType}`,
      `compute   ${fmtHr(est.computeHr)}`,
      `disk      ${fmtHr(est.diskHr)}`,
      `total     ${fmtHr(est.totalHr)}  (${monthly} if left running)`,
    ].join('\n'),
    'Review',
  );
  p.log.info('Ports are governed by the shared firewall (infra/terraform), not set here.');

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
    ports: [],
  };

  const create = p.spinner();
  create.start(`Provisioning '${id}'`);
  try {
    const running = await provider.create(spec);
    create.stop(`Created '${id}'`);
    p.outro(`Reachable at ${running.address} — SSH in, install your game, then \`stop\` to snapshot it.`);
  } catch (err) {
    create.stop('Provisioning failed', 1);
    throw err;
  }
}
