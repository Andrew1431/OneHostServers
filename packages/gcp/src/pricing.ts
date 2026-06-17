/**
 * On-demand price estimates for the interactive picker.
 *
 * The Compute Engine API (machineTypes.list) does NOT return prices — pricing
 * lives in the separate Cloud Billing Catalog API as per-region, per-resource
 * SKUs (vCPU-hour + RAM-GiB-hour, billed separately). GCP charges a machine as
 * `vcpus * coreRate + (memoryMb/1024) * ramRate` per hour, so a small static
 * rate table reproduces the real bill exactly for both predefined and custom
 * types — no runtime billing call needed.
 *
 * Rates below were pulled from the Billing Catalog for `northamerica-northeast2`
 * (Toronto) on 2026-06-17. They are REGION-SPECIFIC: if the deployment zone
 * moves to another region these become estimates only — `estimate()` flags that
 * via `regionMatches`. Refresh by re-querying cloudbilling SKUs for the region.
 */

export const PRICED_REGION = 'northamerica-northeast2';
export const HOURS_PER_MONTH = 730;

/** $/hr per vCPU and per GiB of RAM, by machine family. */
interface FamilyRate {
  /** Predefined types (e.g. n2-standard-4). */
  core: number;
  ram: number;
  /** Custom types (e.g. n2-custom-8-16384), when the family supports them. */
  customCore?: number;
  customRam?: number;
}

const FAMILY_RATES: Record<string, FamilyRate> = {
  e2: { core: 0.0240134, ram: 0.0032182, customCore: 0.025214, customRam: 0.0033791 },
  n1: { core: 0.034802, ram: 0.004664 },
  n2: { core: 0.034802, ram: 0.004664, customCore: 0.0365421, customRam: 0.0048972 },
  n2d: { core: 0.030278, ram: 0.004058, customCore: 0.0317919, customRam: 0.0042609 },
  t2d: { core: 0.030278, ram: 0.004058 },
  c2d: { core: 0.032551, ram: 0.004359 },
  c3: { core: 0.0381531, ram: 0.0043361 },
  c3d: { core: 0.0325518, ram: 0.0043593 },
  c4: { core: 0.0381531, ram: 0.0043361 },
};

/** $/GiB-month of disk capacity, by GCP disk type. */
const DISK_RATES: Record<string, number> = {
  'pd-standard': 0.044,
  'pd-balanced': 0.11,
  'pd-ssd': 0.187,
  'pd-extreme': 0.138,
  'hyperdisk-balanced': 0.088,
};

/** Family token of a machine type, e.g. "n2-custom-8-16384" -> "n2". */
export function familyOf(machineType: string): string {
  return machineType.split('-')[0] ?? machineType;
}

function isCustom(machineType: string): boolean {
  return machineType.includes('-custom-');
}

/** Compute-only $/hr for a machine type, or undefined if the family is unpriced. */
export function machineHourly(
  machineType: string,
  vcpus: number,
  memoryMb: number,
): number | undefined {
  const rate = FAMILY_RATES[familyOf(machineType)];
  if (rate === undefined) return undefined;
  const core = (isCustom(machineType) && rate.customCore) || rate.core;
  const ram = (isCustom(machineType) && rate.customRam) || rate.ram;
  return vcpus * core + (memoryMb / 1024) * ram;
}

/** Disk $/hr for a capacity, or undefined if the disk type is unpriced. */
export function diskHourly(diskType: string, diskGb: number): number | undefined {
  const monthly = DISK_RATES[diskType];
  if (monthly === undefined) return undefined;
  return (monthly * diskGb) / HOURS_PER_MONTH;
}

export interface Estimate {
  computeHr: number | undefined;
  diskHr: number | undefined;
  /** Sum of the known components; undefined only if both are unknown. */
  totalHr: number | undefined;
  monthlyTotal: number | undefined;
  /** True when the priced region matches the deployment region. */
  regionMatches: boolean;
}

export function estimate(args: {
  region: string;
  machineType: string;
  vcpus: number;
  memoryMb: number;
  diskType: string;
  diskGb: number;
}): Estimate {
  const computeHr = machineHourly(args.machineType, args.vcpus, args.memoryMb);
  const diskHr = diskHourly(args.diskType, args.diskGb);
  const totalHr =
    computeHr === undefined && diskHr === undefined
      ? undefined
      : (computeHr ?? 0) + (diskHr ?? 0);
  return {
    computeHr,
    diskHr,
    totalHr,
    monthlyTotal: totalHr === undefined ? undefined : totalHr * HOURS_PER_MONTH,
    regionMatches: args.region === PRICED_REGION,
  };
}

/** "$0.123/hr" — compact, fixed precision; "?" when unknown. */
export function fmtHr(n: number | undefined): string {
  return n === undefined ? '~?/hr' : `~$${n.toFixed(3)}/hr`;
}
