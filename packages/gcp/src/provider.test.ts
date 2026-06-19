import { describe, it, expect } from 'vitest';
import { GcpServerProvider } from './provider.ts';
import {
  SERVER_LABEL,
  MACHINE_LABEL,
  DISKTYPE_LABEL,
  DNS_HOST_LABEL,
  NAGGED_LABEL,
  DEFAULT_MACHINE_TYPE,
  DEFAULT_DISK_TYPE,
  type GcpConfig,
} from './config.ts';
import { instanceName, snapshotName } from './naming.ts';
import {
  makeFakeGcp,
  capacityError,
  notFoundError,
  type FakeGcpOptions,
  type FakeInstance,
} from './__fixtures__/fakeGcp.ts';
import type { ServerSpec } from '@onehost/core';
import type { FakeGcp } from './__fixtures__/fakeGcp.ts';

/** Args of the first recorded call to `method`, typed as `T`; throws if there were none. */
function firstArgs<T>(fake: FakeGcp, method: string): T {
  const c = fake.callsTo(method)[0];
  if (c === undefined) throw new Error(`expected a call to ${method}, found none`);
  return c.args as T;
}

const cfg: GcpConfig = {
  projectId: 'proj',
  zone: 'us-central1-a',
  sourceImage: 'projects/debian-cloud/global/images/family/debian-12',
  networkTag: 'onehost',
};

/** A region with three UP zones; the configured zone (-a) is tried first. */
const threeZones: FakeGcpOptions['zones'] = [
  { name: 'us-central1-a', region: 'x/regions/us-central1' },
  { name: 'us-central1-b', region: 'x/regions/us-central1' },
  { name: 'us-central1-c', region: 'x/regions/us-central1' },
];

function provider(opts: FakeGcpOptions = {}) {
  const fake = makeFakeGcp(opts);
  return { p: new GcpServerProvider(cfg, fake.clients), fake };
}

const ID = 'srv1';

/** Spec with an explicit machine type so we can assert the labels deterministically. */
function spec(over: Partial<ServerSpec> = {}): ServerSpec {
  return {
    id: ID,
    ownerDiscordId: 'd1',
    machine: { vcpus: 2, memoryMb: 4096, diskGb: 20, diskType: 'pd-balanced', type: 'n2-standard-2' },
    ports: [],
    region: 'us-central1',
    ...over,
  };
}

/** A RUNNING instance with a reachable IP, placed at `name`/zone via the seed map. */
function runningInstance(over: Partial<FakeInstance> = {}): FakeInstance {
  return {
    name: instanceName(ID),
    status: 'RUNNING',
    networkInterfaces: [{ accessConfigs: [{ natIP: '1.2.3.4' }] }],
    ...over,
  };
}

describe('withZoneFallback (create)', () => {
  it('falls through to the next zone on a capacity error', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      instancesByZone: { 'us-central1-b': [runningInstance()] },
    });
    // First zone (-a) is out of capacity; -b succeeds.
    fake.failNext('instances.insert', capacityError());

    const res = await p.create(spec());
    expect(res.address).toBe('1.2.3.4');

    // Two insert attempts: failed -a, then -b.
    const inserts = fake.callsTo('instances.insert');
    expect(inserts).toHaveLength(2);
    expect((inserts[0]?.args as { zone: string }).zone).toBe('us-central1-a');
    expect((inserts[1]?.args as { zone: string }).zone).toBe('us-central1-b');
  });

  it('exhausts all zones and rethrows the last capacity error', async () => {
    const { p, fake } = provider({ zones: threeZones });
    fake.failNext('instances.insert', capacityError('zone-a'));
    fake.failNext('instances.insert', capacityError('zone-b'));
    fake.failNext('instances.insert', capacityError('zone-c'));

    await expect(p.create(spec())).rejects.toThrow('zone-c');
    expect(fake.callsTo('instances.insert')).toHaveLength(3);
  });

  it('propagates a non-capacity error immediately without trying other zones', async () => {
    const { p, fake } = provider({ zones: threeZones });
    fake.failNext('instances.insert', new Error('PERMISSION_DENIED'));

    await expect(p.create(spec())).rejects.toThrow('PERMISSION_DENIED');
    expect(fake.callsTo('instances.insert')).toHaveLength(1); // no fallback
  });
});

describe('failed-start disk cleanup', () => {
  const snap = { name: snapshotName(ID, 1000), labels: { [SERVER_LABEL]: instanceName(ID) }, creationTimestamp: '2024-01-01T00:00:00Z' };

  it('deletes the disk when the instance insert fails, before trying the next zone', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [snap],
      instancesByZone: { 'us-central1-b': [runningInstance()] },
    });
    // disk insert ok in -a, instance insert fails (capacity) in -a → cleanup, retry -b.
    fake.failNext('instances.insert', capacityError());

    await p.start(ID);

    const diskDeletes = fake.callsTo('disks.delete');
    expect(diskDeletes).toHaveLength(1);
    expect((diskDeletes[0]?.args as { zone: string }).zone).toBe('us-central1-a');
    // Ordering: disk.insert(-a) → instance.insert(-a, fails) → disk.delete(-a) → disk.insert(-b).
    const seq = fake.calls.map((c) => c.method);
    const firstInstInsert = seq.indexOf('instances.insert');
    const diskDelete = seq.indexOf('disks.delete');
    expect(diskDelete).toBeGreaterThan(firstInstInsert);
  });

  it('still deletes the disk on a non-capacity failure (then rethrows)', async () => {
    const { p, fake } = provider({ zones: threeZones, snapshots: [snap] });
    fake.failNext('instances.insert', new Error('boom'));

    await expect(p.start(ID)).rejects.toThrow('boom');
    expect(fake.callsTo('disks.delete')).toHaveLength(1);
    expect(fake.callsTo('disks.insert')).toHaveLength(1); // no zone fallback for non-capacity
  });
});

describe('stop', () => {
  it('is idempotent with allowAlreadyStopped when no instance is found', async () => {
    const { p, fake } = provider({ instancesByZone: {} });
    await expect(p.stop(ID, { allowAlreadyStopped: true })).resolves.toBeUndefined();
    // Nothing snapshotted/deleted.
    expect(fake.callsTo('disks.createSnapshot')).toHaveLength(0);
    expect(fake.callsTo('instances.delete')).toHaveLength(0);
  });

  it('throws when no instance is found and allowAlreadyStopped is off', async () => {
    const { p } = provider({ instancesByZone: {} });
    await expect(p.stop(ID)).rejects.toThrow(/not running/);
  });

  it('skips the ACPI instances.stop when the instance is not RUNNING', async () => {
    const { p, fake } = provider({
      instancesByZone: { 'us-central1-a': [runningInstance({ status: 'TERMINATED' })] },
    });
    await p.stop(ID);
    expect(fake.callsTo('instances.stop')).toHaveLength(0); // no ACPI
    // But it still snapshots + deletes.
    expect(fake.callsTo('disks.createSnapshot')).toHaveLength(1);
    expect(fake.callsTo('instances.delete')).toHaveLength(1);
  });

  it('sends ACPI instances.stop when RUNNING', async () => {
    const { p, fake } = provider({
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    await p.stop(ID);
    expect(fake.callsTo('instances.stop')).toHaveLength(1);
  });
});

describe('sizing-label carry-forward', () => {
  it('snapshots with the instance machine/disk labels', async () => {
    const { p, fake } = provider({
      instancesByZone: {
        'us-central1-a': [
          runningInstance({ labels: { [MACHINE_LABEL]: 'c2-standard-4', [DISKTYPE_LABEL]: 'pd-ssd' } }),
        ],
      },
    });
    await p.stop(ID);

    const labels = firstArgs<{ snapshotResource: { labels: Record<string, string> } }>(
      fake,
      'disks.createSnapshot',
    ).snapshotResource.labels;
    expect(labels[MACHINE_LABEL]).toBe('c2-standard-4');
    expect(labels[DISKTYPE_LABEL]).toBe('pd-ssd');
    expect(labels[SERVER_LABEL]).toBe(instanceName(ID));
  });

  it('omits sizing labels when the instance has none', async () => {
    const { p, fake } = provider({
      instancesByZone: { 'us-central1-a': [runningInstance({ labels: {} })] },
    });
    await p.stop(ID);
    const labels = firstArgs<{ snapshotResource: { labels: Record<string, string> } }>(
      fake,
      'disks.createSnapshot',
    ).snapshotResource.labels;
    expect(labels[MACHINE_LABEL]).toBeUndefined();
    expect(labels[DISKTYPE_LABEL]).toBeUndefined();
  });

  it('start restores using snapshot labels (snapshot label beats default)', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [
        {
          name: snapshotName(ID, 1000),
          labels: { [SERVER_LABEL]: instanceName(ID), [MACHINE_LABEL]: 'c2-standard-8', [DISKTYPE_LABEL]: 'pd-ssd' },
          creationTimestamp: '2024-01-01T00:00:00Z',
        },
      ],
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    await p.start(ID);

    const ir = firstArgs<{
      instanceResource: { machineType: string; labels: Record<string, string> };
    }>(fake, 'instances.insert').instanceResource;
    expect(ir.machineType).toContain('c2-standard-8');
    expect(ir.labels[MACHINE_LABEL]).toBe('c2-standard-8');
    expect(ir.labels[DISKTYPE_LABEL]).toBe('pd-ssd');

    const diskResource = firstArgs<{ diskResource: { type: string } }>(fake, 'disks.insert').diskResource;
    expect(diskResource.type).toContain('pd-ssd');
  });

  it('start prefers an explicit override over the snapshot label', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [
        {
          name: snapshotName(ID, 1000),
          labels: { [SERVER_LABEL]: instanceName(ID), [MACHINE_LABEL]: 'c2-standard-8', [DISKTYPE_LABEL]: 'pd-ssd' },
          creationTimestamp: '2024-01-01T00:00:00Z',
        },
      ],
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    await p.start(ID, { machineType: 'n2-standard-16', diskType: 'pd-standard' });

    const ir = firstArgs<{
      instanceResource: { machineType: string; labels: Record<string, string> };
    }>(fake, 'instances.insert').instanceResource;
    expect(ir.machineType).toContain('n2-standard-16');
    expect(ir.labels[DISKTYPE_LABEL]).toBe('pd-standard');
  });

  it('start falls back to defaults when the snapshot has no sizing labels', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [
        { name: snapshotName(ID, 1000), labels: { [SERVER_LABEL]: instanceName(ID) }, creationTimestamp: '2024-01-01T00:00:00Z' },
      ],
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    await p.start(ID);
    const ir = firstArgs<{
      instanceResource: { machineType: string; labels: Record<string, string> };
    }>(fake, 'instances.insert').instanceResource;
    expect(ir.machineType).toContain(DEFAULT_MACHINE_TYPE);
    expect(ir.labels[DISKTYPE_LABEL]).toBe(DEFAULT_DISK_TYPE);
  });

  it('throws when there is no snapshot to restore', async () => {
    const { p } = provider({ zones: threeZones, snapshots: [] });
    await expect(p.start(ID)).rejects.toThrow(/No snapshot/);
  });
});

describe('latest-snapshot selection', () => {
  it('picks the newest snapshot by creationTimestamp', async () => {
    const older = { name: 'snap-old', labels: { [SERVER_LABEL]: instanceName(ID), [MACHINE_LABEL]: 'old' }, creationTimestamp: '2024-01-01T00:00:00Z' };
    const newer = { name: 'snap-new', labels: { [SERVER_LABEL]: instanceName(ID), [MACHINE_LABEL]: 'new' }, creationTimestamp: '2024-06-01T00:00:00Z' };
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [older, newer],
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    await p.start(ID);

    // Disk restored from the newer snapshot, and its label used for sizing.
    const diskResource = firstArgs<{ diskResource: { sourceSnapshot: string } }>(fake, 'disks.insert').diskResource;
    expect(diskResource.sourceSnapshot).toContain('snap-new');
    const ir = firstArgs<{ instanceResource: { machineType: string } }>(fake, 'instances.insert').instanceResource;
    expect(ir.machineType).toContain('new');
  });
});

describe('reconcile', () => {
  const HOUR = 3_600_000;
  function instanceUpFor(hours: number, over: Partial<FakeInstance> = {}): FakeInstance {
    return runningInstance({
      labels: { [SERVER_LABEL]: ID, ...over.labels },
      lastStartTimestamp: new Date(Date.now() - hours * HOUR).toISOString(),
      labelFingerprint: 'fp1',
      ...over,
    });
  }

  it('is disabled when maxUptimeHours <= 0', async () => {
    const { p, fake } = provider({ instancesByZone: { 'us-central1-a': [instanceUpFor(100)] } });
    const report = await p.reconcile({ maxUptimeHours: 0 });
    expect(report).toEqual({ warned: [], stopped: [] });
    expect(fake.calls).toHaveLength(0); // short-circuits before any list
  });

  it('warns once for an over-threshold instance and stamps the NAGGED label', async () => {
    const { p, fake } = provider({ instancesByZone: { 'us-central1-a': [instanceUpFor(10)] } });
    const report = await p.reconcile({ maxUptimeHours: 5 });
    expect(report.warned.map((s) => s.id)).toEqual([ID]);
    expect(report.stopped).toHaveLength(0);

    const setLabels = fake.callsTo('instances.setLabels');
    expect(setLabels).toHaveLength(1);
    const labels = firstArgs<{
      instancesSetLabelsRequestResource: { labels: Record<string, string> };
    }>(fake, 'instances.setLabels').instancesSetLabelsRequestResource.labels;
    expect(labels[NAGGED_LABEL]).toBeDefined();
  });

  it('does not re-warn an already-NAGGED instance', async () => {
    const { p, fake } = provider({
      instancesByZone: { 'us-central1-a': [instanceUpFor(10, { labels: { [SERVER_LABEL]: ID, [NAGGED_LABEL]: '123' } })] },
    });
    const report = await p.reconcile({ maxUptimeHours: 5 });
    expect(report.warned).toHaveLength(0);
    expect(fake.callsTo('instances.setLabels')).toHaveLength(0);
  });

  it('does not warn an instance below the threshold', async () => {
    const { p, fake } = provider({ instancesByZone: { 'us-central1-a': [instanceUpFor(2)] } });
    const report = await p.reconcile({ maxUptimeHours: 5 });
    expect(report.warned).toHaveLength(0);
    expect(fake.callsTo('instances.setLabels')).toHaveLength(0);
  });

  it('auto-stops only when autoStopUptimeHours >= maxUptimeHours and uptime crosses it', async () => {
    const { p, fake } = provider({ instancesByZone: { 'us-central1-a': [instanceUpFor(12)] } });
    const report = await p.reconcile({ maxUptimeHours: 5, autoStopUptimeHours: 10 });
    expect(report.stopped.map((s) => s.id)).toEqual([ID]);
    expect(report.warned).toHaveLength(0);
    // Stop path ran (ACPI on a RUNNING instance + snapshot + delete).
    expect(fake.callsTo('instances.stop')).toHaveLength(1);
    expect(fake.callsTo('disks.createSnapshot')).toHaveLength(1);
  });

  it('ignores autoStop when below maxUptime (would stop before warning) — warns instead', async () => {
    // autoStopUptimeHours < maxUptimeHours → treated as undefined; falls to warn.
    const { p, fake } = provider({ instancesByZone: { 'us-central1-a': [instanceUpFor(8)] } });
    const report = await p.reconcile({ maxUptimeHours: 5, autoStopUptimeHours: 3 });
    expect(report.stopped).toHaveLength(0);
    expect(report.warned.map((s) => s.id)).toEqual([ID]);
    expect(fake.callsTo('instances.stop')).toHaveLength(0);
  });

  it('does not auto-stop when over max but under the autoStop ceiling — warns', async () => {
    const { p } = provider({ instancesByZone: { 'us-central1-a': [instanceUpFor(7)] } });
    const report = await p.reconcile({ maxUptimeHours: 5, autoStopUptimeHours: 10 });
    expect(report.stopped).toHaveLength(0);
    expect(report.warned.map((s) => s.id)).toEqual([ID]);
  });

  it('derives uptime from creationTimestamp when lastStartTimestamp is absent', async () => {
    const inst = runningInstance({
      labels: { [SERVER_LABEL]: ID },
      labelFingerprint: 'fp',
      creationTimestamp: new Date(Date.now() - 9 * HOUR).toISOString(),
    });
    const { p } = provider({ instancesByZone: { 'us-central1-a': [inst] } });
    const report = await p.reconcile({ maxUptimeHours: 5 });
    expect(report.warned.map((s) => s.id)).toEqual([ID]);
    expect(report.warned[0]?.uptimeHours).toBeGreaterThanOrEqual(9);
  });

  it('skips non-RUNNING instances', async () => {
    const inst = instanceUpFor(100, { status: 'TERMINATED' });
    const { p, fake } = provider({ instancesByZone: { 'us-central1-a': [inst] } });
    const report = await p.reconcile({ maxUptimeHours: 5 });
    expect(report.warned).toHaveLength(0);
    expect(fake.callsTo('instances.setLabels')).toHaveLength(0);
  });
});

describe('snapshot prune (via stop)', () => {
  function snaps(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      name: `snap-${i}`,
      labels: { [SERVER_LABEL]: instanceName(ID) },
      // i=0 oldest ... but include the just-created one too via createSnapshot? Provider lists
      // after creating; the fake's list is static, so we model the post-stop set directly.
      creationTimestamp: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
    }));
  }

  it('keeps the newest N and deletes the rest (newest-first)', async () => {
    // keep=3 (default). Seed 5 snapshots; expect the 2 oldest deleted.
    const { p, fake } = provider({
      instancesByZone: { 'us-central1-a': [runningInstance()] },
      snapshots: snaps(5),
    });
    await p.stop(ID);
    const deleted = fake.callsTo('snapshots.delete').map((c) => (c.args as { snapshot: string }).snapshot);
    // Newest-first sort → keep snap-4,snap-3,snap-2 ; delete snap-1, snap-0.
    expect(deleted).toEqual(['snap-1', 'snap-0']);
  });

  it('keeps everything when snapshotKeep <= 0', async () => {
    const fake = makeFakeGcp({
      instancesByZone: { 'us-central1-a': [runningInstance()] },
      snapshots: snaps(5),
    });
    const p = new GcpServerProvider({ ...cfg, snapshotKeep: 0 }, fake.clients);
    await p.stop(ID);
    expect(fake.callsTo('snapshots.delete')).toHaveLength(0);
  });
});

describe('dns host label', () => {
  const DNS = 'mc-onehost';

  it('create stamps the dns label and returns dnsHost when spec.dns is set', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    const res = await p.create(spec({ dns: { provider: 'duckdns', hostname: DNS } }));
    expect(res.dnsHost).toBe(DNS);

    const labels = firstArgs<{ instanceResource: { labels: Record<string, string> } }>(
      fake,
      'instances.insert',
    ).instanceResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBe(DNS);
  });

  it('create omits the dns label when spec.dns is absent', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    const res = await p.create(spec());
    expect(res.dnsHost).toBeUndefined();
    const labels = firstArgs<{ instanceResource: { labels: Record<string, string> } }>(
      fake,
      'instances.insert',
    ).instanceResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBeUndefined();
  });

  it('stop carries the dns label onto the snapshot', async () => {
    const { p, fake } = provider({
      instancesByZone: { 'us-central1-a': [runningInstance({ labels: { [DNS_HOST_LABEL]: DNS } })] },
    });
    await p.stop(ID);
    const labels = firstArgs<{ snapshotResource: { labels: Record<string, string> } }>(
      fake,
      'disks.createSnapshot',
    ).snapshotResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBe(DNS);
  });

  it('start re-stamps the dns label from the snapshot and returns dnsHost', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [
        {
          name: snapshotName(ID, 1000),
          labels: { [SERVER_LABEL]: instanceName(ID), [DNS_HOST_LABEL]: DNS },
          creationTimestamp: '2024-01-01T00:00:00Z',
        },
      ],
      instancesByZone: { 'us-central1-a': [runningInstance()] },
    });
    const res = await p.start(ID);
    expect(res.dnsHost).toBe(DNS);
    const labels = firstArgs<{ instanceResource: { labels: Record<string, string> } }>(
      fake,
      'instances.insert',
    ).instanceResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBe(DNS);
  });

  it('list surfaces dnsHost for a live server', async () => {
    const { p } = provider({
      instancesByZone: {
        'us-central1-a': [runningInstance({ labels: { [SERVER_LABEL]: ID, [DNS_HOST_LABEL]: DNS } })],
      },
    });
    const row = (await p.list()).find((s) => s.id === ID);
    expect(row?.dnsHost).toBe(DNS);
  });

  it('setDnsHost on a running server stamps the instance label', async () => {
    const { p, fake } = provider({
      instancesByZone: {
        'us-central1-a': [runningInstance({ labels: { [SERVER_LABEL]: ID }, labelFingerprint: 'fp' })],
      },
    });
    await p.setDnsHost(ID, DNS);
    const labels = firstArgs<{
      instancesSetLabelsRequestResource: { labels: Record<string, string> };
    }>(fake, 'instances.setLabels').instancesSetLabelsRequestResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBe(DNS);
  });

  it('setDnsHost --clear removes the instance label', async () => {
    const { p, fake } = provider({
      instancesByZone: {
        'us-central1-a': [
          runningInstance({ labels: { [SERVER_LABEL]: ID, [DNS_HOST_LABEL]: DNS }, labelFingerprint: 'fp' }),
        ],
      },
    });
    await p.setDnsHost(ID, undefined);
    const labels = firstArgs<{
      instancesSetLabelsRequestResource: { labels: Record<string, string> };
    }>(fake, 'instances.setLabels').instancesSetLabelsRequestResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBeUndefined();
  });

  it('setDnsHost on a stopped server stamps the latest snapshot label', async () => {
    const { p, fake } = provider({
      instancesByZone: {},
      snapshots: [
        {
          name: snapshotName(ID, 1000),
          labels: { [SERVER_LABEL]: instanceName(ID) },
          labelFingerprint: 'sfp',
          creationTimestamp: '2024-01-01T00:00:00Z',
        },
      ],
    });
    await p.setDnsHost(ID, DNS);
    const labels = firstArgs<{
      globalSetLabelsRequestResource: { labels: Record<string, string> };
    }>(fake, 'snapshots.setLabels').globalSetLabelsRequestResource.labels;
    expect(labels[DNS_HOST_LABEL]).toBe(DNS);
  });
});

describe('list merge', () => {
  it('merges live instances with snapshot-only STOPPED servers', async () => {
    const live = runningInstance({
      name: instanceName('live'),
      labels: { [SERVER_LABEL]: 'live', [MACHINE_LABEL]: 'n2-standard-2', [DISKTYPE_LABEL]: 'pd-balanced' },
    });
    const { p } = provider({
      instancesByZone: { 'us-central1-a': [live] },
      snapshots: [
        // snapshot-only server "stopped1"
        { name: 'st-old', labels: { [SERVER_LABEL]: 'stopped1', [MACHINE_LABEL]: 'old-m' }, creationTimestamp: '2024-01-01T00:00:00Z' },
        { name: 'st-new', labels: { [SERVER_LABEL]: 'stopped1', [MACHINE_LABEL]: 'new-m', [DISKTYPE_LABEL]: 'pd-ssd' }, creationTimestamp: '2024-06-01T00:00:00Z' },
        // snapshot for the live server is ignored (already live)
        { name: 'live-snap', labels: { [SERVER_LABEL]: 'live' }, creationTimestamp: '2024-06-01T00:00:00Z' },
      ],
    });
    const list = await p.list();
    const get = (id: string) => {
      const row = list.find((s) => s.id === id);
      if (row === undefined) throw new Error(`expected ${id} in list`);
      return row;
    };

    expect(get('live').state).toBe('RUNNING');
    expect(get('live').zone).toBe('us-central1-a');
    expect(get('live').address).toBe('1.2.3.4');

    expect(get('stopped1').state).toBe('STOPPED');
    expect(get('stopped1').zone).toBeUndefined();
    // Newest snapshot labels win.
    expect(get('stopped1').machineType).toBe('new-m');
    expect(get('stopped1').diskType).toBe('pd-ssd');
  });
});

describe('error classification (via behavior)', () => {
  it('treats a gRPC code-5 not-found from disk delete cleanup as a no-op (start still rethrows original)', async () => {
    const { p, fake } = provider({
      zones: threeZones,
      snapshots: [{ name: snapshotName(ID, 1), labels: { [SERVER_LABEL]: instanceName(ID) }, creationTimestamp: '2024-01-01T00:00:00Z' }],
    });
    // instance insert fails non-capacity; disk delete during cleanup throws not-found (swallowed).
    fake.failNext('instances.insert', new Error('insert failed'));
    fake.failNext('disks.delete', notFoundError());

    await expect(p.start(ID)).rejects.toThrow('insert failed'); // original error, cleanup swallowed
  });
});
