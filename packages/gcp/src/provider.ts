import {
  InstancesClient,
  DisksClient,
  SnapshotsClient,
  ZonesClient,
  ZoneOperationsClient,
  GlobalOperationsClient,
  type protos,
} from '@google-cloud/compute';
import type {
  ServerId,
  ServerSpec,
  ServerStatus,
  ServerState,
  ServerSummary,
  RunningServer,
} from '@onehost/core';
import {
  type ServerProvider,
  type StartOptions,
  ServerNotFoundError,
} from '@onehost/provider-api';
import {
  SERVER_LABEL,
  MACHINE_LABEL,
  DISKTYPE_LABEL,
  DEFAULT_DISK_TYPE,
  DEFAULT_MACHINE_TYPE,
  DEFAULT_SNAPSHOT_KEEP,
  type GcpConfig,
} from './config.ts';
import {
  instanceName,
  diskName,
  snapshotName,
  machineTypeName,
} from './naming.ts';
import { waitZonal, waitGlobal } from './operations.ts';

/**
 * GCP implementation of the provider seam. Lifecycle uses disk snapshots so it
 * is game-agnostic: we never look inside the disk, just snapshot/restore it.
 *
 *   create : fresh disk from base image -> instance
 *   stop   : snapshot disk -> delete instance (+disk via autoDelete)
 *   start  : disk from latest snapshot -> instance
 *   destroy: delete instance + all of the server's snapshots
 */
export class GcpServerProvider implements ServerProvider {
  private readonly instances = new InstancesClient();
  private readonly disks = new DisksClient();
  private readonly snapshots = new SnapshotsClient();
  private readonly zones = new ZonesClient();
  private readonly zoneOps = new ZoneOperationsClient();
  private readonly globalOps = new GlobalOperationsClient();

  constructor(private readonly cfg: GcpConfig) {}

  /** Region derived from the zone, e.g. "northamerica-northeast2-a" -> "...northeast2". */
  private get region(): string {
    return this.cfg.zone.replace(/-[a-z]$/, '');
  }

  /**
   * Attach instances to OUR VPC (not the project's `default` network) so the
   * Terraform firewall rules — which target this network + the `onehost` tag —
   * actually apply. An ephemeral external IP is added for reachability.
   */
  private networkInterface() {
    const { projectId } = this.cfg;
    return [
      {
        network: `projects/${projectId}/global/networks/onehost`,
        subnetwork: `projects/${projectId}/regions/${this.region}/subnetworks/onehost`,
        accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }],
      },
    ];
  }

  async create(spec: ServerSpec): Promise<RunningServer> {
    const { projectId } = this.cfg;
    const name = instanceName(spec.id);
    const machineType = machineTypeName(spec.machine);
    const diskType = spec.machine.diskType;

    // Single atomic insert (inline boot disk) — nothing to clean up on failure,
    // so capacity exhaustion just moves to the next zone.
    return this.withZoneFallback(async (zone) => {
      const [resp] = await this.instances.insert({
        project: projectId,
        zone,
        instanceResource: {
          name,
          machineType: `zones/${zone}/machineTypes/${machineType}`,
          tags: { items: [this.cfg.networkTag] },
          labels: {
            [SERVER_LABEL]: name,
            [MACHINE_LABEL]: machineType,
            [DISKTYPE_LABEL]: diskType,
          },
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: this.cfg.sourceImage,
                diskSizeGb: spec.machine.diskGb,
                diskType: `zones/${zone}/diskTypes/${diskType}`,
              },
            },
          ],
          networkInterfaces: this.networkInterface(),
        },
      });
      await waitZonal(this.zoneOps, projectId, zone, resp);
      return { id: spec.id, address: await this.requireAddress(spec.id, zone) };
    });
  }

  async start(id: ServerId, opts: StartOptions = {}): Promise<RunningServer> {
    const { projectId } = this.cfg;
    const snapshot = await this.latestSnapshotRecord(id);
    if (snapshot === undefined) {
      throw new Error(`No snapshot to restore for server '${id}' — was it ever stopped?`);
    }

    // Resolve sizing: explicit override > what the snapshot remembers > defaults.
    const machineType =
      opts.machineType ?? snapshot.labels[MACHINE_LABEL] ?? DEFAULT_MACHINE_TYPE;
    const diskType =
      opts.diskType ?? snapshot.labels[DISKTYPE_LABEL] ?? DEFAULT_DISK_TYPE;

    const name = instanceName(id);
    // The snapshot is global, so a STOPPED server can restore into any zone with
    // capacity. Try the preferred zone first, then the rest of the region. Each
    // attempt is disk-then-instance; on failure we delete the disk we just made
    // so a retry doesn't collide and a final failure doesn't orphan it.
    return this.withZoneFallback(async (zone) => {
      try {
        // 1. Recreate the disk from the snapshot, with the chosen disk type.
        const [diskResp] = await this.disks.insert({
          project: projectId,
          zone,
          diskResource: {
            name: diskName(id),
            sourceSnapshot: `projects/${projectId}/global/snapshots/${snapshot.name}`,
            type: `zones/${zone}/diskTypes/${diskType}`,
          },
        });
        await waitZonal(this.zoneOps, projectId, zone, diskResp);

        // 2. Boot an instance attached to that disk, re-stamping the sizing
        //    labels so the next stop/start cycle remembers them.
        const [instResp] = await this.instances.insert({
          project: projectId,
          zone,
          instanceResource: {
            name,
            machineType: `zones/${zone}/machineTypes/${machineType}`,
            tags: { items: [this.cfg.networkTag] },
            labels: {
              [SERVER_LABEL]: name,
              [MACHINE_LABEL]: machineType,
              [DISKTYPE_LABEL]: diskType,
            },
            disks: [
              {
                boot: true,
                autoDelete: true,
                source: `projects/${projectId}/zones/${zone}/disks/${diskName(id)}`,
              },
            ],
            networkInterfaces: this.networkInterface(),
          },
        });
        await waitZonal(this.zoneOps, projectId, zone, instResp);
        return { id, address: await this.requireAddress(id, zone) };
      } catch (err) {
        // Anything failed after we may have created the disk — it's now attached
        // to nothing and would bill forever; remove it (no-op if it was never
        // created) before we retry the next zone or give up.
        await this.deleteDiskQuietly(id, zone);
        throw err;
      }
    });
  }

  async stop(id: ServerId): Promise<void> {
    const { projectId } = this.cfg;
    const name = instanceName(id);

    // Find where the instance actually runs — capacity may have placed it in a
    // different zone than configured, so we don't trust cfg.zone here.
    const found = await this.locate(id);
    if (found === undefined) {
      throw new Error(`Server '${id}' is not running — nothing to stop`);
    }
    const { zone, instance } = found;

    // Carry the instance's sizing forward so `start` can restore it (or it can
    // be overridden). Older instances may lack these labels — that's fine, the
    // restore falls back to defaults.
    const sizing: Record<string, string> = { [SERVER_LABEL]: name };
    const machineLabel = instance.labels?.[MACHINE_LABEL];
    const diskLabel = instance.labels?.[DISKTYPE_LABEL];
    if (machineLabel) sizing[MACHINE_LABEL] = machineLabel;
    if (diskLabel) sizing[DISKTYPE_LABEL] = diskLabel;

    // 1. Snapshot the boot disk (labelled so we can find it on next start).
    const [snapResp] = await this.disks.createSnapshot({
      project: projectId,
      zone,
      disk: diskName(id),
      snapshotResource: {
        name: snapshotName(id),
        labels: sizing,
      },
    });
    await waitZonal(this.zoneOps, projectId, zone, snapResp);

    // 2. Delete the instance; autoDelete removes the boot disk with it.
    const [delResp] = await this.instances.delete({
      project: projectId,
      zone,
      instance: name,
    });
    await waitZonal(this.zoneOps, projectId, zone, delResp);

    // 3. Prune old snapshots so storage stays bounded as the server cycles.
    await this.pruneSnapshots(id, this.cfg.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP);
  }

  async destroy(id: ServerId): Promise<void> {
    const { projectId } = this.cfg;
    const name = instanceName(id);

    const found = await this.locate(id);
    if (found !== undefined) {
      const [delResp] = await this.instances.delete({
        project: projectId,
        zone: found.zone,
        instance: name,
      });
      await waitZonal(this.zoneOps, projectId, found.zone, delResp);
    }

    for (const snap of await this.listSnapshots(id)) {
      const [snapDel] = await this.snapshots.delete({ project: projectId, snapshot: snap });
      await waitGlobal(this.globalOps, projectId, snapDel);
    }
  }

  async status(id: ServerId): Promise<ServerStatus> {
    const found = await this.locate(id);
    if (found === undefined) {
      // No instance in any zone => stopped (snapshot may or may not exist).
      return { state: 'STOPPED' };
    }
    const state = mapInstanceStatus(found.instance.status ?? undefined);
    const address = extractAddress(found.instance);
    return address === undefined ? { state } : { state, address };
  }

  async list(): Promise<ServerSummary[]> {
    const { projectId } = this.cfg;
    const summaries = new Map<ServerId, ServerSummary>();

    // 1. Live instances across every zone — no need to know the zone up front,
    //    which is also how we discover where a server actually landed.
    const aggregated = this.instances.aggregatedListAsync({ project: projectId });
    for await (const [scope, scoped] of aggregated) {
      for (const inst of scoped.instances ?? []) {
        const id = inst.labels?.[SERVER_LABEL];
        if (!id) continue; // not a OneHost instance
        const address = extractAddress(inst);
        const machineType = inst.labels?.[MACHINE_LABEL];
        const diskType = inst.labels?.[DISKTYPE_LABEL];
        summaries.set(id, {
          id,
          state: mapInstanceStatus(inst.status ?? undefined),
          zone: scope.replace(/^zones\//, ''),
          ...(address ? { address } : {}),
          ...(machineType ? { machineType } : {}),
          ...(diskType ? { diskType } : {}),
        });
      }
    }

    // 2. STOPPED servers: those with snapshots but no live instance. Keep the
    //    newest snapshot's labels so the listed sizing matches what `start` restores.
    const stopped = new Map<ServerId, { labels: Record<string, string>; ts: string }>();
    const snaps = this.snapshots.listAsync({ project: projectId });
    for await (const snap of snaps) {
      const id = snap.labels?.[SERVER_LABEL];
      if (!id || summaries.has(id)) continue;
      const ts = snap.creationTimestamp ?? '';
      const cur = stopped.get(id);
      if (cur === undefined || ts > cur.ts) stopped.set(id, { labels: snap.labels ?? {}, ts });
    }
    for (const [id, { labels }] of stopped) {
      const machineType = labels[MACHINE_LABEL];
      const diskType = labels[DISKTYPE_LABEL];
      summaries.set(id, {
        id,
        state: 'STOPPED',
        ...(machineType ? { machineType } : {}),
        ...(diskType ? { diskType } : {}),
      });
    }

    return [...summaries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Run a zonal action, falling back through the region's zones when one is out
   * of capacity. The configured zone is tried first; any non-capacity error
   * propagates immediately (only `ZONE_RESOURCE_POOL_EXHAUSTED`-style stockouts
   * are worth retrying elsewhere). The action must clean up its own partial work
   * before throwing, since the next zone reuses the same resource names.
   */
  private async withZoneFallback<T>(action: (zone: string) => Promise<T>): Promise<T> {
    const zones = await this.orderedZones();
    let lastErr: unknown;
    for (const zone of zones) {
      try {
        return await action(zone);
      } catch (err) {
        if (!isCapacityError(err)) throw err;
        lastErr = err;
        console.warn(`zone ${zone} out of capacity; trying the next zone`);
      }
    }
    throw lastErr ?? new Error('no zones available in the region');
  }

  /** Region's UP zones, configured zone first so it stays the default placement. */
  private async orderedZones(): Promise<string[]> {
    const preferred = this.cfg.zone;
    const { projectId } = this.cfg;
    const region = this.region;
    const others: string[] = [];
    try {
      const iterable = this.zones.listAsync({ project: projectId, filter: 'status = UP' });
      for await (const z of iterable) {
        if (z.name && z.name !== preferred && z.region?.endsWith(`/regions/${region}`)) {
          others.push(z.name);
        }
      }
    } catch (err) {
      // If zone discovery fails, still attempt the configured zone.
      console.warn('zone discovery failed; using only the configured zone:', err);
    }
    others.sort();
    return [preferred, ...others];
  }

  /** Best-effort disk delete used to compensate a failed start; ignores not-found. */
  private async deleteDiskQuietly(id: ServerId, zone: string): Promise<void> {
    const { projectId } = this.cfg;
    try {
      const [resp] = await this.disks.delete({ project: projectId, zone, disk: diskName(id) });
      await waitZonal(this.zoneOps, projectId, zone, resp);
    } catch (err) {
      if (!isNotFound(err)) {
        console.error(`cleanup: could not delete disk ${diskName(id)} in ${zone}:`, err);
      }
    }
  }

  private async getInstance(id: ServerId, zone: string) {
    const { projectId } = this.cfg;
    try {
      const [instance] = await this.instances.get({
        project: projectId,
        zone,
        instance: instanceName(id),
      });
      return instance;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * Find a server's live instance across all zones, returning it with the zone
   * it sits in. Lets stop/status/destroy work without knowing the zone up front,
   * since capacity can place a server somewhere other than the configured zone.
   */
  private async locate(
    id: ServerId,
  ): Promise<{ instance: protos.google.cloud.compute.v1.IInstance; zone: string } | undefined> {
    const { projectId } = this.cfg;
    const name = instanceName(id);
    const aggregated = this.instances.aggregatedListAsync({
      project: projectId,
      filter: `name=${name}`,
    });
    for await (const [scope, scoped] of aggregated) {
      for (const instance of scoped.instances ?? []) {
        if (instance.name === name) {
          return { instance, zone: scope.replace(/^zones\//, '') };
        }
      }
    }
    return undefined;
  }

  private async requireAddress(id: ServerId, zone: string): Promise<string> {
    const instance = await this.getInstance(id, zone);
    const address = instance === undefined ? undefined : extractAddress(instance);
    if (address === undefined) throw new ServerNotFoundError(id);
    return address;
  }

  private async listSnapshots(id: ServerId): Promise<string[]> {
    const { projectId } = this.cfg;
    const name = instanceName(id);
    const names: string[] = [];
    const iterable = this.snapshots.listAsync({
      project: projectId,
      filter: `labels.${SERVER_LABEL}=${name}`,
    });
    for await (const snap of iterable) {
      if (snap.name) names.push(snap.name);
    }
    return names;
  }

  /** Keep the newest `keep` snapshots for a server; delete the rest. */
  private async pruneSnapshots(id: ServerId, keep: number): Promise<void> {
    if (keep <= 0) return; // <= 0 disables pruning (keep everything)
    const { projectId } = this.cfg;
    const name = instanceName(id);
    const snaps: Array<{ name: string; ts: string }> = [];
    const iterable = this.snapshots.listAsync({
      project: projectId,
      filter: `labels.${SERVER_LABEL}=${name}`,
    });
    for await (const snap of iterable) {
      if (snap.name) snaps.push({ name: snap.name, ts: snap.creationTimestamp ?? '' });
    }
    // Newest first, then drop everything past the keep window.
    snaps.sort((a, b) => b.ts.localeCompare(a.ts));
    for (const stale of snaps.slice(keep)) {
      const [del] = await this.snapshots.delete({ project: projectId, snapshot: stale.name });
      await waitGlobal(this.globalOps, projectId, del);
    }
  }

  /** Newest snapshot for a server (with its sizing labels), if any. */
  private async latestSnapshotRecord(
    id: ServerId,
  ): Promise<{ name: string; labels: Record<string, string> } | undefined> {
    const { projectId } = this.cfg;
    const name = instanceName(id);
    let latest: { name: string; labels: Record<string, string>; ts: string } | undefined;
    const iterable = this.snapshots.listAsync({
      project: projectId,
      filter: `labels.${SERVER_LABEL}=${name}`,
    });
    for await (const snap of iterable) {
      if (!snap.name) continue;
      const ts = snap.creationTimestamp ?? '';
      if (latest === undefined || ts > latest.ts) {
        latest = { name: snap.name, labels: snap.labels ?? {}, ts };
      }
    }
    return latest === undefined ? undefined : { name: latest.name, labels: latest.labels };
  }
}

function mapInstanceStatus(status: string | undefined): ServerState {
  switch (status) {
    case 'RUNNING':
      return 'RUNNING';
    case 'PROVISIONING':
    case 'STAGING':
      return 'STARTING';
    case 'STOPPING':
    case 'SUSPENDING':
      return 'STOPPING';
    default:
      return 'STOPPED';
  }
}

function extractAddress(
  instance: protos.google.cloud.compute.v1.IInstance,
): string | undefined {
  return instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? undefined;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 5;
}

/**
 * A zone stockout — the machine type isn't available in this zone right now, but
 * may be in another. Worth retrying elsewhere (unlike quota, which is regional/
 * global and a different zone won't help).
 */
function isCapacityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /RESOURCE_POOL_EXHAUSTED|does not have enough resources|ZONE_RESOURCE_POOL_EXHAUSTED/i.test(msg);
}
