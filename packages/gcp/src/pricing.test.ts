import { describe, it, expect } from 'vitest';
import {
  machineHourly,
  diskHourly,
  estimate,
  familyOf,
  fmtHr,
  PRICED_REGION,
  HOURS_PER_MONTH,
} from './pricing.ts';

// Rates duplicated here so the math is asserted against literals, not the table.
const E2 = { core: 0.0240134, ram: 0.0032182, customCore: 0.025214, customRam: 0.0033791 };
const N1 = { core: 0.034802, ram: 0.004664 }; // n1 has no custom rates

describe('familyOf', () => {
  it('takes the token before the first hyphen', () => {
    expect(familyOf('n2-custom-8-16384')).toBe('n2');
    expect(familyOf('e2-standard-4')).toBe('e2');
  });

  it('returns the whole string when there is no hyphen', () => {
    expect(familyOf('n2')).toBe('n2');
  });
});

describe('machineHourly', () => {
  it('uses predefined rates for a predefined type', () => {
    const got = machineHourly('e2-standard-4', 4, 16384);
    expect(got).toBeCloseTo(4 * E2.core + (16384 / 1024) * E2.ram, 10);
  });

  it('uses custom rates for an e2-custom type', () => {
    const got = machineHourly('e2-custom-4-8192', 4, 8192);
    expect(got).toBeCloseTo(4 * E2.customCore + (8192 / 1024) * E2.customRam, 10);
  });

  it('falls back to predefined rates for a custom type in a family without custom rates', () => {
    const got = machineHourly('n1-custom-4-8192', 4, 8192);
    expect(got).toBeCloseTo(4 * N1.core + (8192 / 1024) * N1.ram, 10);
  });

  it('returns undefined for an unknown family', () => {
    expect(machineHourly('z9-standard-4', 4, 8192)).toBeUndefined();
  });
});

describe('diskHourly', () => {
  it('prorates the known monthly rate to hourly', () => {
    expect(diskHourly('pd-balanced', 20)).toBeCloseTo((0.11 * 20) / HOURS_PER_MONTH, 10);
  });

  it('returns undefined for an unknown disk type', () => {
    expect(diskHourly('floppy', 20)).toBeUndefined();
  });
});

describe('estimate', () => {
  it('sums compute + disk and computes monthlyTotal', () => {
    const e = estimate({
      region: PRICED_REGION,
      machineType: 'e2-standard-4',
      vcpus: 4,
      memoryMb: 16384,
      diskType: 'pd-balanced',
      diskGb: 20,
    });
    expect(e.computeHr).toBeDefined();
    expect(e.diskHr).toBeDefined();
    expect(e.totalHr).toBeCloseTo(e.computeHr! + e.diskHr!, 10);
    expect(e.monthlyTotal).toBeCloseTo(e.totalHr! * HOURS_PER_MONTH, 10);
  });

  it('totalHr is defined when only compute is known (disk unknown)', () => {
    const e = estimate({
      region: PRICED_REGION,
      machineType: 'e2-standard-4',
      vcpus: 4,
      memoryMb: 16384,
      diskType: 'floppy',
      diskGb: 20,
    });
    expect(e.diskHr).toBeUndefined();
    expect(e.totalHr).toBeCloseTo(e.computeHr!, 10);
  });

  it('totalHr is defined when only disk is known (compute unknown)', () => {
    const e = estimate({
      region: PRICED_REGION,
      machineType: 'z9-standard-4',
      vcpus: 4,
      memoryMb: 16384,
      diskType: 'pd-balanced',
      diskGb: 20,
    });
    expect(e.computeHr).toBeUndefined();
    expect(e.totalHr).toBeCloseTo(e.diskHr!, 10);
  });

  it('totalHr + monthlyTotal undefined only when BOTH are unknown', () => {
    const e = estimate({
      region: PRICED_REGION,
      machineType: 'z9-standard-4',
      vcpus: 4,
      memoryMb: 16384,
      diskType: 'floppy',
      diskGb: 20,
    });
    expect(e.totalHr).toBeUndefined();
    expect(e.monthlyTotal).toBeUndefined();
  });

  it('regionMatches reflects the priced region', () => {
    const args = {
      machineType: 'e2-standard-4',
      vcpus: 4,
      memoryMb: 16384,
      diskType: 'pd-balanced',
      diskGb: 20,
    };
    expect(estimate({ ...args, region: PRICED_REGION }).regionMatches).toBe(true);
    expect(estimate({ ...args, region: 'us-central1' }).regionMatches).toBe(false);
  });
});

describe('fmtHr', () => {
  it('formats a number to 3 dp', () => {
    expect(fmtHr(0.1234)).toBe('~$0.123/hr');
  });

  it('renders the undefined case', () => {
    expect(fmtHr(undefined)).toBe('~?/hr');
  });
});
