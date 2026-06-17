import { MachineTypesClient, DiskTypesClient } from '@google-cloud/compute';
import type { GcpConfig } from './config.ts';
import { familyOf } from './pricing.ts';

/** One predefined machine type available in a zone. */
export interface MachineTypeInfo {
  name: string;
  family: string;
  vcpus: number;
  memoryMb: number;
  sharedCpu: boolean;
}

/**
 * Live lookups of what GCP actually offers in a zone, for the interactive
 * `create` picker. Predefined machine types and disk types are returned exactly
 * as the zone reports them, so anything offered here is guaranteed valid for
 * `create` (custom machine types aren't enumerable — the CLI builds those from
 * the well-known `<family>-custom-<vcpus>-<memMb>` formula instead).
 */
export class GcpCatalog {
  private readonly machineTypes = new MachineTypesClient();
  private readonly diskTypes = new DiskTypesClient();

  constructor(private readonly cfg: GcpConfig) {}

  /** Non-deprecated predefined machine types in the zone, smallest first. */
  async listMachineTypes(zone: string = this.cfg.zone): Promise<MachineTypeInfo[]> {
    const out: MachineTypeInfo[] = [];
    const iterable = this.machineTypes.listAsync({ project: this.cfg.projectId, zone });
    for await (const mt of iterable) {
      if (mt.deprecated?.state) continue; // skip DEPRECATED/OBSOLETE
      if (!mt.name || mt.guestCpus == null || mt.memoryMb == null) continue;
      out.push({
        name: mt.name,
        family: familyOf(mt.name),
        vcpus: mt.guestCpus,
        memoryMb: mt.memoryMb,
        sharedCpu: mt.isSharedCpu ?? false,
      });
    }
    out.sort((a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb);
    return out;
  }

  /** Persistent-disk type names in the zone (pd-* and hyperdisk-*; no local-ssd). */
  async listDiskTypes(zone: string = this.cfg.zone): Promise<string[]> {
    const names: string[] = [];
    const iterable = this.diskTypes.listAsync({ project: this.cfg.projectId, zone });
    for await (const dt of iterable) {
      const name = dt.name ?? '';
      if (name.startsWith('pd-') || name.startsWith('hyperdisk-')) names.push(name);
    }
    return [...new Set(names)].sort();
  }
}
