import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UsageError,
  parseFlags,
  parsePorts,
  parsePortFlag,
  parseStartOpts,
  parseSweepOpts,
  parseDnsHost,
  buildSpec,
} from './parse.ts';

describe('parseDnsHost', () => {
  it('accepts a bare subdomain label', () => {
    expect(parseDnsHost('my-mc')).toBe('my-mc');
  });

  it('strips a .duckdns.org suffix and lowercases', () => {
    expect(parseDnsHost('My-MC.duckdns.org')).toBe('my-mc');
  });

  it.each([['bad host'], ['under_score'], ['-leading'], ['trailing-'], ['has.dot']])(
    'rejects %s',
    (raw) => {
      expect(() => parseDnsHost(raw)).toThrow(UsageError);
    },
  );
});

describe('parsePortFlag', () => {
  it('parses a single port', () => {
    expect(parsePortFlag('tcp:25565')).toEqual([{ protocol: 'tcp', port: '25565' }]);
  });

  it('parses a range', () => {
    expect(parsePortFlag('udp:15636-15637')).toEqual([{ protocol: 'udp', port: '15636-15637' }]);
  });

  it('parses a comma list of ports and ranges into separate rules', () => {
    expect(parsePortFlag('tcp:80,443,1000-1001')).toEqual([
      { protocol: 'tcp', port: '80' },
      { protocol: 'tcp', port: '443' },
      { protocol: 'tcp', port: '1000-1001' },
    ]);
  });

  it('rejects a reversed range', () => {
    expect(() => parsePortFlag('tcp:200-100')).toThrow(UsageError);
    expect(() => parsePortFlag('tcp:200-100')).toThrow(/reversed range/);
  });

  it('rejects a port above 65535', () => {
    expect(() => parsePortFlag('tcp:70000')).toThrow(/out of range/);
  });

  it('rejects a port below 1', () => {
    expect(() => parsePortFlag('tcp:0')).toThrow(/out of range/);
  });

  it('rejects a bad protocol', () => {
    expect(() => parsePortFlag('sctp:80')).toThrow(/want tcp/);
  });

  it('rejects a missing port', () => {
    expect(() => parsePortFlag('tcp:')).toThrow(/missing port/);
  });

  it('rejects a non-numeric token', () => {
    expect(() => parsePortFlag('tcp:abc')).toThrow(/use N or N-M/);
  });
});

describe('parsePorts', () => {
  it('returns [] for no flags (clears the rule)', () => {
    expect(parsePorts([])).toEqual([]);
  });

  it('collects multiple --port flags', () => {
    expect(parsePorts(['--port', 'tcp:80', '--port', 'udp:53'])).toEqual([
      { protocol: 'tcp', port: '80' },
      { protocol: 'udp', port: '53' },
    ]);
  });

  it('rejects an unknown flag', () => {
    expect(() => parsePorts(['--nope', 'x'])).toThrow(/unknown flag/);
  });
});

describe('parseFlags', () => {
  it('defaults when nothing passed', () => {
    expect(parseFlags([])).toEqual({
      vcpus: 2,
      memory: 4096,
      disk: 20,
      diskType: 'pd-balanced',
      ports: [],
    });
  });

  it('parses all sizing flags + a port', () => {
    expect(
      parseFlags([
        '--vcpus', '4',
        '--memory', '8192',
        '--disk', '40',
        '--disk-type', 'pd-ssd',
        '--machine', 'n2-standard-4',
        '--port', 'tcp:25565',
      ]),
    ).toEqual({
      vcpus: 4,
      memory: 8192,
      disk: 40,
      diskType: 'pd-ssd',
      machine: 'n2-standard-4',
      ports: [{ protocol: 'tcp', port: '25565' }],
    });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseFlags(['--bogus', 'x'])).toThrow(UsageError);
  });
});

describe('parseStartOpts', () => {
  it('is empty when no overrides passed', () => {
    expect(parseStartOpts([])).toEqual({});
  });

  it('only includes explicitly-passed overrides', () => {
    expect(parseStartOpts(['--machine', 'c2-standard-4'])).toEqual({
      machineType: 'c2-standard-4',
    });
    expect(parseStartOpts(['--disk-type', 'pd-ssd'])).toEqual({ diskType: 'pd-ssd' });
    expect(parseStartOpts(['--disk', '40'])).toEqual({ diskSizeGb: 40 });
  });

  it('combines overrides', () => {
    expect(parseStartOpts(['--machine', 'c2-standard-4', '--disk', '50'])).toEqual({
      machineType: 'c2-standard-4',
      diskSizeGb: 50,
    });
  });

  it('rejects a non-positive disk size', () => {
    expect(() => parseStartOpts(['--disk', '0'])).toThrow(/positive integer/);
    expect(() => parseStartOpts(['--disk', '-5'])).toThrow(/positive integer/);
  });

  it('rejects a non-integer disk size', () => {
    expect(() => parseStartOpts(['--disk', '4.5'])).toThrow(/positive integer/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseStartOpts(['--vcpus', '4'])).toThrow(/unknown flag/);
  });

  it('parses --persist as a value-less boolean', () => {
    expect(parseStartOpts(['--persist'])).toEqual({ persist: true });
  });

  it('combines --persist with value flags without consuming the next token', () => {
    expect(parseStartOpts(['--persist', '--machine', 'c2-standard-4'])).toEqual({
      persist: true,
      machineType: 'c2-standard-4',
    });
    expect(parseStartOpts(['--machine', 'c2-standard-4', '--persist'])).toEqual({
      persist: true,
      machineType: 'c2-standard-4',
    });
  });
});

describe('parseSweepOpts', () => {
  const ENV_KEYS = ['ONEHOST_MAX_UPTIME_HOURS', 'ONEHOST_AUTOSTOP_UPTIME_HOURS'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to 0/0 with no flags or env', () => {
    expect(parseSweepOpts([])).toEqual({ maxUptimeHours: 0, autoStopUptimeHours: 0 });
  });

  it('falls back to env when no flags passed', () => {
    process.env.ONEHOST_MAX_UPTIME_HOURS = '12';
    process.env.ONEHOST_AUTOSTOP_UPTIME_HOURS = '24';
    expect(parseSweepOpts([])).toEqual({ maxUptimeHours: 12, autoStopUptimeHours: 24 });
  });

  it('flags win over env', () => {
    process.env.ONEHOST_MAX_UPTIME_HOURS = '12';
    expect(parseSweepOpts(['--max-uptime', '6', '--autostop', '8'])).toEqual({
      maxUptimeHours: 6,
      autoStopUptimeHours: 8,
    });
  });

  it('guards against NaN from a non-numeric flag', () => {
    expect(() => parseSweepOpts(['--max-uptime', 'soon'])).toThrow(/need a number/);
  });

  it('guards against NaN from a non-numeric env', () => {
    process.env.ONEHOST_MAX_UPTIME_HOURS = 'soon';
    expect(() => parseSweepOpts([])).toThrow(/need a number/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseSweepOpts(['--nope', '1'])).toThrow(/unknown flag/);
  });
});

describe('buildSpec', () => {
  const savedZone = process.env.GCP_ZONE;
  beforeEach(() => {
    delete process.env.GCP_ZONE;
  });
  afterEach(() => {
    if (savedZone === undefined) delete process.env.GCP_ZONE;
    else process.env.GCP_ZONE = savedZone;
  });

  it('builds a ServerSpec from flags', () => {
    const spec = buildSpec('mc', {
      vcpus: 4,
      memory: 8192,
      disk: 40,
      diskType: 'pd-ssd',
      ports: [{ protocol: 'tcp', port: '25565' }],
    });
    expect(spec).toEqual({
      id: 'mc',
      ownerDiscordId: 'cli',
      region: 'us-central1',
      machine: { vcpus: 4, memoryMb: 8192, diskGb: 40, diskType: 'pd-ssd' },
      ports: [{ protocol: 'tcp', port: '25565' }],
    });
  });

  it('includes dns only when --dns was passed', () => {
    const withDns = buildSpec('mc', {
      vcpus: 2,
      memory: 4096,
      disk: 20,
      diskType: 'pd-balanced',
      ports: [],
      dns: 'my-mc',
    });
    expect(withDns.dns).toEqual({ provider: 'duckdns', hostname: 'my-mc' });

    const noDns = buildSpec('mc', { vcpus: 2, memory: 4096, disk: 20, diskType: 'pd-balanced', ports: [] });
    expect(noDns.dns).toBeUndefined();
  });

  it('parses --dns through parseFlags', () => {
    expect(parseFlags(['--dns', 'My-MC.duckdns.org']).dns).toBe('my-mc');
  });

  it('includes machine.type only when set, and derives region from GCP_ZONE', () => {
    process.env.GCP_ZONE = 'europe-west1-b';
    const spec = buildSpec('mc', {
      vcpus: 2,
      memory: 4096,
      disk: 20,
      diskType: 'pd-balanced',
      machine: 'n2-standard-4',
      ports: [],
    });
    expect(spec.region).toBe('europe-west1');
    expect(spec.machine.type).toBe('n2-standard-4');
  });
});
