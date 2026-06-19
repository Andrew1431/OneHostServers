import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryProvider } from '@onehost/testing';
import type { GcpConfig } from '@onehost/gcp';

/**
 * Drives the interactive create/start flows without a TTY: @clack/prompts is
 * mocked with scripted answer queues, and GcpCatalog is stubbed so no GCP call
 * happens. We assert the *decisions* — the ServerSpec/StartOptions that reach the
 * provider, and that every cancel point aborts without provisioning — not the
 * rendered UI.
 */

// Mutable holder the hoisted mock factories read from (vi.mock is hoisted above
// imports, so it can't close over normal module-scope vars).
const h = vi.hoisted(() => ({
  CANCEL: Symbol('clack-cancel'),
  selectQ: [] as unknown[],
  textQ: [] as unknown[],
  confirmQ: [] as unknown[],
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  isCancel: (v: unknown) => v === h.CANCEL,
  select: vi.fn(async () => h.selectQ.shift()),
  text: vi.fn(async () => h.textQ.shift()),
  confirm: vi.fn(async () => h.confirmQ.shift()),
}));

vi.mock('@onehost/gcp', async (importActual) => {
  const actual = await importActual<typeof import('@onehost/gcp')>();
  class MockCatalog {
    constructor(_cfg: unknown) {}
    async listMachineTypes() {
      return [
        { name: 'e2-standard-2', family: 'e2', vcpus: 2, memoryMb: 8192, sharedCpu: false },
        { name: 'e2-standard-4', family: 'e2', vcpus: 4, memoryMb: 16384, sharedCpu: false },
        // a shared-core type that must be filtered out of the picker
        { name: 'e2-small', family: 'e2', vcpus: 2, memoryMb: 2048, sharedCpu: true },
      ];
    }
    async listDiskTypes() {
      return ['pd-standard', 'pd-balanced', 'pd-ssd'];
    }
  }
  return { ...actual, GcpCatalog: MockCatalog };
});

// Imported after the mocks are declared (vi.mock is hoisted regardless).
const { createInteractively, startInteractively, validatePortsInput, parsePortsInput } =
  await import('./interactive.ts');

const cfg: GcpConfig = {
  projectId: 'test-project',
  zone: 'us-central1-a',
  sourceImage: 'projects/debian-cloud/global/images/family/debian-12',
  networkTag: 'onehost',
};

beforeEach(() => {
  h.selectQ = [];
  h.textQ = [];
  h.confirmQ = [];
});

describe('createInteractively', () => {
  it('builds the spec from a predefined machine choice and provisions', async () => {
    const provider = new InMemoryProvider();
    h.selectQ = ['e2', 'e2-standard-2', 'pd-balanced']; // family, size, disk type
    h.textQ = ['20', 'tcp:25565']; // disk size, ports
    h.confirmQ = [true]; // confirm create

    await createInteractively(provider, { id: 'vanilla', cfg });

    const create = provider.calls.find((c) => c.method === 'create');
    expect(create).toBeDefined();
    expect(create!.args[0]).toMatchObject({
      id: 'vanilla',
      region: 'us-central1',
      machine: {
        type: 'e2-standard-2',
        vcpus: 2,
        memoryMb: 8192,
        diskGb: 20,
        diskType: 'pd-balanced',
      },
      ports: [{ protocol: 'tcp', port: '25565' }],
    });
  });

  it('builds a custom machine type from vCPU + RAM ratio', async () => {
    const provider = new InMemoryProvider();
    // family, __custom__, vCPUs, RAM-per-vCPU, disk type
    h.selectQ = ['e2', '__custom__', '4', '2', 'pd-ssd'];
    h.textQ = ['30', '']; // disk size, blank ports
    h.confirmQ = [true];

    await createInteractively(provider, { id: 'custom', cfg });

    const spec = provider.calls.find((c) => c.method === 'create')!.args[0] as {
      machine: { type: string; vcpus: number; memoryMb: number };
      ports: unknown[];
    };
    expect(spec.machine.type).toBe('e2-custom-4-8192'); // 4 vCPU * 2 GB * 1024
    expect(spec.machine.vcpus).toBe(4);
    expect(spec.machine.memoryMb).toBe(8192);
    expect(spec.ports).toEqual([]);
  });

  it('does not provision when the final confirm is declined', async () => {
    const provider = new InMemoryProvider();
    h.selectQ = ['e2', 'e2-standard-2', 'pd-balanced'];
    h.textQ = ['20', ''];
    h.confirmQ = [false];

    await createInteractively(provider, { id: 'declined', cfg });

    expect(provider.calls.some((c) => c.method === 'create')).toBe(false);
  });

  it.each([
    ['family tier', ['__CANCEL__'] as unknown[]],
    ['machine size', ['e2', '__CANCEL__']],
    ['disk type', ['e2', 'e2-standard-2', '__CANCEL__']],
  ])('aborts without provisioning when cancelled at the %s step', async (_label, rawSelect) => {
    const provider = new InMemoryProvider();
    h.selectQ = rawSelect.map((v) => (v === '__CANCEL__' ? h.CANCEL : v));
    h.textQ = ['20', ''];
    h.confirmQ = [true];

    await createInteractively(provider, { id: 'cancelled', cfg });

    expect(provider.calls.some((c) => c.method === 'create')).toBe(false);
  });
});

describe('startInteractively', () => {
  it('starts with no overrides when both "change?" prompts are declined', async () => {
    const provider = new InMemoryProvider();
    provider.seed('survival', { state: 'STOPPED', machineType: 'n2-standard-4', diskType: 'pd-balanced' });
    h.confirmQ = [false, false, true]; // change machine?, change disk?, start now?

    await startInteractively(provider, { id: 'survival', cfg });

    const start = provider.calls.find((c) => c.method === 'start');
    expect(start).toBeDefined();
    expect(start!.args[1]).toEqual({}); // no StartOptions overrides
  });

  it('passes a machine override when the user opts to change the tier', async () => {
    const provider = new InMemoryProvider();
    provider.seed('survival', { state: 'STOPPED', machineType: 'e2-standard-2', diskType: 'pd-balanced' });
    h.confirmQ = [true, false, true]; // change machine? yes; change disk? no; start? yes
    h.selectQ = ['e2', 'e2-standard-4']; // tier + size for the override

    await startInteractively(provider, { id: 'survival', cfg });

    const start = provider.calls.find((c) => c.method === 'start')!;
    expect(start.args[1]).toMatchObject({ machineType: 'e2-standard-4' });
  });

  it('does not start an unknown server', async () => {
    const provider = new InMemoryProvider();
    await startInteractively(provider, { id: 'ghost', cfg });
    expect(provider.calls.some((c) => c.method === 'start')).toBe(false);
  });
});

describe('validatePortsInput', () => {
  it('accepts blank and well-formed entries', () => {
    expect(validatePortsInput('')).toBeUndefined();
    expect(validatePortsInput('  ')).toBeUndefined();
    expect(validatePortsInput('tcp:25565')).toBeUndefined();
    expect(validatePortsInput('tcp:80,443 udp:15636-15637')).toBeUndefined();
  });

  it.each([
    ['ftp:21', 'bad protocol'],
    ['tcp:', 'missing port'],
    ['tcp:abc', 'non-numeric token'],
    ['tcp:0', 'below range'],
    ['tcp:70000', 'above range'],
    ['udp:200-100', 'reversed range'],
  ])('rejects %s (%s)', (raw) => {
    expect(validatePortsInput(raw)).toBeTypeOf('string');
  });
});

describe('parsePortsInput', () => {
  it('expands lists and ranges into one rule per token', () => {
    expect(parsePortsInput('')).toEqual([]);
    expect(parsePortsInput('tcp:80,443 udp:15636-15637')).toEqual([
      { protocol: 'tcp', port: '80' },
      { protocol: 'tcp', port: '443' },
      { protocol: 'udp', port: '15636-15637' },
    ]);
  });
});
