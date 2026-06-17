import {
  InstancesClient,
  DisksClient,
  SnapshotsClient,
  ZoneOperationsClient,
  GlobalOperationsClient,
  type protos,
} from '@google-cloud/compute';
import type {
  ServerId,
  ServerSpec,
  ServerStatus,
  ServerState,
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
    const { projectId, zone } = this.cfg;
    const name = instanceName(spec.id);
    const machineType = machineTypeName(spec.machine);
    const diskType = spec.machine.diskType;

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
    return { id: spec.id, address: await this.requireAddress(spec.id) };
  }

  async start(id: ServerId, opts: StartOptions = {}): Promise<RunningServer> {
    const { projectId, zone } = this.cfg;
    const snapshot = await this.latestSnapshotRecord(id);
    if (snapshot === undefined) {
      throw new Error(`No snapshot to restore for server '${id}' — was it ever stopped?`);
    }

    // Resolve sizing: explicit override > what the snapshot remembers > defaults.
    const machineType =
      opts.machineType ?? snapshot.labels[MACHINE_LABEL] ?? DEFAULT_MACHINE_TYPE;
    const diskType =
      opts.diskType ?? snapshot.labels[DISKTYPE_LABEL] ?? DEFAULT_DISK_TYPE;

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

    // 2. Boot an instance attached to that disk, re-stamping the sizing labels
    //    so the next stop/start cycle remembers them.
    const name = instanceName(id);
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
    return { id, address: await this.requireAddress(id) };
  }

  async stop(id: ServerId): Promise<void> {
    const { projectId, zone } = this.cfg;
    const name = instanceName(id);

    // Carry the instance's sizing forward so `start` can restore it (or it can
    // be overridden). Older instances may lack these labels — that's fine, the
    // restore falls back to defaults.
    const instance = await this.getInstance(id);
    const sizing: Record<string, string> = { [SERVER_LABEL]: name };
    const machineLabel = instance?.labels?.[MACHINE_LABEL];
    const diskLabel = instance?.labels?.[DISKTYPE_LABEL];
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
  }

  async destroy(id: ServerId): Promise<void> {
    const { projectId, zone } = this.cfg;
    const name = instanceName(id);

    if (await this.instanceExists(id)) {
      const [delResp] = await this.instances.delete({
        project: projectId,
        zone,
        instance: name,
      });
      await waitZonal(this.zoneOps, projectId, zone, delResp);
    }

    for (const snap of await this.listSnapshots(id)) {
      const [snapDel] = await this.snapshots.delete({ project: projectId, snapshot: snap });
      await waitGlobal(this.globalOps, projectId, snapDel);
    }
  }

  async status(id: ServerId): Promise<ServerStatus> {
    const instance = await this.getInstance(id);
    if (instance === undefined) {
      // No instance => stopped (snapshot may or may not exist; either way STOPPED).
      return { state: 'STOPPED' };
    }
    const state = mapInstanceStatus(instance.status ?? undefined);
    const address = extractAddress(instance);
    return address === undefined ? { state } : { state, address };
  }

  // --- helpers ---------------------------------------------------------------

  private async getInstance(id: ServerId) {
    const { projectId, zone } = this.cfg;
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

  private async instanceExists(id: ServerId): Promise<boolean> {
    return (await this.getInstance(id)) !== undefined;
  }

  private async requireAddress(id: ServerId): Promise<string> {
    const instance = await this.getInstance(id);
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
