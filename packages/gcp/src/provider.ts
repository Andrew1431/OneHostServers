import {
  InstancesClient,
  DisksClient,
  SnapshotsClient,
  FirewallsClient,
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
  StaleServer,
  PortRule,
} from '@onehost/core';
import {
  type ServerProvider,
  type StartOptions,
  type StopOptions,
  type ReconcileOptions,
  type ReconcileReport,
  ServerNotFoundError,
} from '@onehost/provider-api';
import {
  SERVER_LABEL,
  MACHINE_LABEL,
  DISKTYPE_LABEL,
  NAGGED_LABEL,
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
  serverTag,
  firewallRuleName,
} from './naming.ts';
import { waitZonal, waitGlobal } from './operations.ts';

/**
 * The seven GCP Compute clients the provider drives. Bundled so they can be
 * injected as a unit — production passes the real clients ({@link defaultClients}),
 * tests pass a recording fake. Keeping them behind one type means a new client
 * is a single edit here rather than another constructor parameter everywhere.
 */
export interface GcpClients {
  instances: InstancesClient;
  disks: DisksClient;
  snapshots: SnapshotsClient;
  firewalls: FirewallsClient;
  zones: ZonesClient;
  zoneOps: ZoneOperationsClient;
  globalOps: GlobalOperationsClient;
}

/** The real GCP clients, with ADC. Used when no clients are injected. */
export function defaultClients(): GcpClients {
  return {
    instances: new InstancesClient(),
    disks: new DisksClient(),
    snapshots: new SnapshotsClient(),
    firewalls: new FirewallsClient(),
    zones: new ZonesClient(),
    zoneOps: new ZoneOperationsClient(),
    globalOps: new GlobalOperationsClient(),
  };
}

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
  private readonly instances: InstancesClient;
  private readonly disks: DisksClient;
  private readonly snapshots: SnapshotsClient;
  private readonly firewalls: FirewallsClient;
  private readonly zones: ZonesClient;
  private readonly zoneOps: ZoneOperationsClient;
  private readonly globalOps: GlobalOperationsClient;

  /**
   * @param cfg     placement + naming config.
   * @param clients GCP clients to drive; defaults to the real ones so existing
   *                `new GcpServerProvider(cfg)` call sites are unaffected. Tests
   *                inject a fake to exercise the resiliency logic off-cloud.
   */
  constructor(
    private readonly cfg: GcpConfig,
    clients: GcpClients = defaultClients(),
  ) {
    this.instances = clients.instances;
    this.disks = clients.disks;
    this.snapshots = clients.snapshots;
    this.firewalls = clients.firewalls;
    this.zones = clients.zones;
    this.zoneOps = clients.zoneOps;
    this.globalOps = clients.globalOps;
  }

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

  /**
   * Per-instance identity fields shared by create + start:
   *  - `metadata.onehost-server-id` so an on-box agent can learn its own id from
   *    the metadata server (MACHINE_AGENT.md checklist #4) — no baked-in config.
   *  - a `serviceAccounts` block iff a game-VM SA is configured, so an idle VM can
   *    publish its own stop. Scoped to pubsub only; the SA's IAM is the real gate.
   */
  private identity(serverId: ServerId) {
    const sa = this.cfg.gameVmServiceAccount;
    return {
      metadata: { items: [{ key: 'onehost-server-id', value: serverId }] },
      ...(sa
        ? {
            serviceAccounts: [
              { email: sa, scopes: ['https://www.googleapis.com/auth/pubsub'] },
            ],
          }
        : {}),
    };
  }

  async create(spec: ServerSpec): Promise<RunningServer> {
    const { projectId } = this.cfg;
    const name = instanceName(spec.id);
    const machineType = machineTypeName(spec.machine);
    const diskType = spec.machine.diskType;

    // The server's own ingress rule (only its ports, targeting its per-server
    // tag). Global resource, so create it once up front — independent of which
    // zone the instance lands in, and harmless if the instance insert later
    // fails (a stray rule is ~$0 and `destroy`/`ports` reclaims it).
    await this.ensureFirewallRule(spec.id, spec.ports);

    // Single atomic insert (inline boot disk) — nothing to clean up on failure,
    // so capacity exhaustion just moves to the next zone.
    return this.withZoneFallback(async (zone) => {
      const [resp] = await this.instances.insert({
        project: projectId,
        zone,
        instanceResource: {
          name,
          machineType: `zones/${zone}/machineTypes/${machineType}`,
          tags: { items: [this.cfg.networkTag, serverTag(spec.id)] },
          ...this.identity(spec.id),
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
            // Optional grow. Omitting it restores at the snapshot's size; GCP
            // rejects a value smaller than the snapshot. The guest resizes the
            // root fs to fill the disk on boot, so no manual growpart needed.
            ...(opts.diskSizeGb ? { sizeGb: String(opts.diskSizeGb) } : {}),
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
            // Re-attach the per-server tag so the persistent firewall rule
            // (created at `create`, untouched by stop/start) matches again. No
            // firewall write here — `start` runs on the worker, which has no
            // securityAdmin; rule lifecycle stays CLI-only.
            tags: { items: [this.cfg.networkTag, serverTag(id)] },
            ...this.identity(id),
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

  async stop(id: ServerId, opts: StopOptions = {}): Promise<void> {
    const { projectId } = this.cfg;
    const name = instanceName(id);

    // Find where the instance actually runs — capacity may have placed it in a
    // different zone than configured, so we don't trust cfg.zone here.
    const found = await this.locate(id);
    if (found === undefined) {
      // Already gone. An idle/retried/swept stop wants this to be success;
      // an operator typo still errors by default.
      if (opts.allowAlreadyStopped) return;
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

    // 0. Quiesce the guest so the snapshot is consistent. `instances.stop` sends
    //    an ACPI soft-off, which runs the VM's shutdown sequence (systemd stops
    //    onehost-game.service -> `docker compose stop` -> SIGTERM + grace window
    //    to the game). The op resolves only once the VM is TERMINATED, i.e. the
    //    disk is quiescent — see MACHINE_AGENT.md for the on-box contract. We
    //    skip this if the VM isn't RUNNING (already stopping/terminated).
    if (instance.status === 'RUNNING') {
      const [stopResp] = await this.instances.stop({ project: projectId, zone, instance: name });
      await waitZonal(this.zoneOps, projectId, zone, stopResp);
    }

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

    // Reclaim the server's own firewall rule (no-op if it never had ports).
    await this.deleteFirewallRule(id);
  }

  /**
   * Replace a server's ingress rule with exactly the given ports — the CLI-only
   * surface for changing what's open (the brief's `ports` command, and the
   * migration tool for servers created before per-server firewalls existed).
   * Takes effect live for a running server; a stopped one picks it up on next
   * start. Empty `ports` removes the rule entirely.
   */
  async setPorts(id: ServerId, ports: PortRule[]): Promise<void> {
    await this.ensureFirewallRule(id, ports);
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

  /**
   * Resolve the live SSH target for a server: its instance name and the zone it
   * actually runs in (capacity may have placed it off the configured zone, so we
   * `locate` rather than assume). GCP-specific — SSH is a gcloud concern, not part
   * of the cloud-agnostic provider seam — so this lives on the concrete class for
   * the CLI to drive `gcloud compute ssh`.
   */
  async resolveSshTarget(
    id: ServerId,
  ): Promise<{ instanceName: string; zone: string; projectId: string }> {
    const found = await this.locate(id);
    if (found === undefined) {
      throw new Error(`Server '${id}' is not running — start it before connecting`);
    }
    return { instanceName: instanceName(id), zone: found.zone, projectId: this.cfg.projectId };
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

  async reconcile(opts: ReconcileOptions): Promise<ReconcileReport> {
    const report: ReconcileReport = { warned: [], stopped: [] };
    if (opts.maxUptimeHours <= 0) return report; // disabled

    const { projectId } = this.cfg;
    const now = Date.now();
    // Auto-stop only when a ceiling is set *and* sane (>= the warn threshold);
    // otherwise we'd stop before ever warning.
    const autoStopAt =
      opts.autoStopUptimeHours && opts.autoStopUptimeHours >= opts.maxUptimeHours
        ? opts.autoStopUptimeHours
        : undefined;

    // One pass over every live OneHost instance, across all zones.
    const aggregated = this.instances.aggregatedListAsync({ project: projectId });
    for await (const [scope, scoped] of aggregated) {
      for (const inst of scoped.instances ?? []) {
        const id = inst.labels?.[SERVER_LABEL];
        if (!id || inst.status !== 'RUNNING') continue;

        // Uptime from when this run started; creation time is the fallback for
        // an instance that has never been explicitly stopped/started.
        const started = inst.lastStartTimestamp ?? inst.creationTimestamp ?? undefined;
        if (!started) continue;
        const uptimeHours = (now - new Date(started).getTime()) / 3_600_000;
        if (uptimeHours < opts.maxUptimeHours) continue;

        const zone = scope.replace(/^zones\//, '');
        const stale: StaleServer = { id, zone, uptimeHours };

        if (autoStopAt !== undefined && uptimeHours >= autoStopAt) {
          // Graceful stop (ACPI → snapshot → delete); idempotent in case a manual
          // stop is racing this sweep.
          await this.stop(id, { allowAlreadyStopped: true });
          report.stopped.push(stale);
        } else if (inst.labels?.[NAGGED_LABEL] === undefined) {
          // First time over the line this run — warn once, then mark so later
          // passes stay quiet until the next stop/start clears the label.
          await this.markNagged(id, zone, inst.labels ?? {}, inst.labelFingerprint ?? undefined);
          report.warned.push(stale);
        }
      }
    }
    return report;
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

  /**
   * Stamp the dedup marker so the sweep won't re-warn about this instance until
   * its next stop/start. `setLabels` needs the current label fingerprint, which
   * the sweep already has from the aggregated list — so no extra GET.
   */
  private async markNagged(
    id: ServerId,
    zone: string,
    currentLabels: Record<string, string>,
    labelFingerprint: string | undefined,
  ): Promise<void> {
    const { projectId } = this.cfg;
    const [resp] = await this.instances.setLabels({
      project: projectId,
      zone,
      instance: instanceName(id),
      instancesSetLabelsRequestResource: {
        labels: { ...currentLabels, [NAGGED_LABEL]: String(Math.floor(Date.now() / 1000)) },
        // GCP requires the current fingerprint for optimistic concurrency; a live
        // instance always has one. `null` only to satisfy the string|null type.
        labelFingerprint: labelFingerprint ?? null,
      },
    });
    await waitZonal(this.zoneOps, projectId, zone, resp);
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

  /**
   * Create-or-replace the server's ingress rule so it opens exactly `ports` on
   * its per-server tag from anywhere. Firewalls are a global resource (mirror the
   * snapshot waits). Empty `ports` => no rule to have, so we delete instead (an
   * allow-rule with no ports is invalid anyway).
   */
  private async ensureFirewallRule(id: ServerId, ports: PortRule[]): Promise<void> {
    if (ports.length === 0) {
      await this.deleteFirewallRule(id);
      return;
    }
    const { projectId } = this.cfg;
    const name = firewallRuleName(id);
    const tcp = ports.filter((p) => p.protocol === 'tcp').map((p) => p.port);
    const udp = ports.filter((p) => p.protocol === 'udp').map((p) => p.port);
    const allowed = [
      ...(tcp.length ? [{ IPProtocol: 'tcp', ports: tcp }] : []),
      ...(udp.length ? [{ IPProtocol: 'udp', ports: udp }] : []),
    ];
    const firewallResource = {
      name,
      network: `projects/${projectId}/global/networks/onehost`,
      direction: 'INGRESS',
      targetTags: [serverTag(id)],
      sourceRanges: ['0.0.0.0/0'],
      allowed,
    };

    // Update in place if it already exists (re-running `ports`, or `create` on a
    // re-used id); otherwise insert. `update` is a full replace, so the rule
    // always reflects exactly the ports passed.
    if (await this.firewallExists(name)) {
      const [resp] = await this.firewalls.update({ project: projectId, firewall: name, firewallResource });
      await waitGlobal(this.globalOps, projectId, resp);
    } else {
      const [resp] = await this.firewalls.insert({ project: projectId, firewallResource });
      await waitGlobal(this.globalOps, projectId, resp);
    }
  }

  /** Best-effort delete of the server's firewall rule; ignores not-found. */
  private async deleteFirewallRule(id: ServerId): Promise<void> {
    const { projectId } = this.cfg;
    const name = firewallRuleName(id);
    try {
      const [resp] = await this.firewalls.delete({ project: projectId, firewall: name });
      await waitGlobal(this.globalOps, projectId, resp);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private async firewallExists(name: string): Promise<boolean> {
    try {
      await this.firewalls.get({ project: this.cfg.projectId, firewall: name });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
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
