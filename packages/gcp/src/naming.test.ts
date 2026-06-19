import { describe, it, expect } from 'vitest';
import type { MachineSpec } from '@onehost/core';
import {
  sanitizeName,
  instanceName,
  diskName,
  snapshotName,
  serverTag,
  firewallRuleName,
  machineTypeName,
} from './naming.ts';

describe('sanitizeName', () => {
  it('lowercases', () => {
    expect(sanitizeName('MyServer')).toBe('myserver');
  });

  it('replaces invalid chars with -', () => {
    expect(sanitizeName('my_server.1')).toBe('my-server-1');
  });

  it('collapses runs of - into one', () => {
    expect(sanitizeName('a___b')).toBe('a-b');
    expect(sanitizeName('a---b')).toBe('a-b');
  });

  it('trims leading/trailing -', () => {
    expect(sanitizeName('-abc-')).toBe('abc');
    expect(sanitizeName('__abc__')).toBe('abc');
  });

  it('prefixes s- when it does not start with a letter', () => {
    expect(sanitizeName('1server')).toBe('s-1server');
    // After trimming leading hyphens a leading digit still triggers the prefix.
    expect(sanitizeName('-9')).toBe('s-9');
  });

  it('does not prefix when already starting with a letter', () => {
    expect(sanitizeName('server1')).toBe('server1');
  });

  it('clamps to 50 chars', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeName(long)).toHaveLength(50);
    expect(sanitizeName(long)).toBe('a'.repeat(50));
  });

  it('clamps after the s- prefix is added', () => {
    const long = '1' + 'a'.repeat(80);
    const out = sanitizeName(long);
    expect(out).toHaveLength(50);
    expect(out.startsWith('s-1')).toBe(true);
  });
});

describe('instanceName / diskName', () => {
  it('equal sanitizeName', () => {
    expect(instanceName('My_Server')).toBe(sanitizeName('My_Server'));
    expect(diskName('My_Server')).toBe(sanitizeName('My_Server'));
  });
});

describe('snapshotName', () => {
  it('formats as <sanitize>-<at>', () => {
    // "My_Server" -> "my-server" (underscore -> single hyphen).
    expect(snapshotName('My_Server', 12345)).toBe('my-server-12345');
    expect(snapshotName('myserver', 12345)).toBe('myserver-12345');
  });
});

describe('serverTag', () => {
  it('prefixes onehost-srv-', () => {
    expect(serverTag('myserver')).toBe('onehost-srv-myserver');
  });
});

describe('firewallRuleName', () => {
  it('prefixes onehost-game-', () => {
    expect(firewallRuleName('myserver')).toBe('onehost-game-myserver');
  });
});

describe('machineTypeName', () => {
  const base: MachineSpec = { vcpus: 4, memoryMb: 8192, diskGb: 20, diskType: 'pd-balanced' };

  it('explicit machine.type wins', () => {
    expect(machineTypeName({ ...base, type: 'n2-standard-4' })).toBe('n2-standard-4');
  });

  it('derives e2-custom-<vcpus>-<memoryMb> when type unset', () => {
    expect(machineTypeName(base)).toBe('e2-custom-4-8192');
  });
});
