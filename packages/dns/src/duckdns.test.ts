import { describe, it, expect, vi, afterEach } from 'vitest';
import { DuckDnsProvider } from './duckdns.ts';

/**
 * DuckDNS adapter tests: assert the exact update URL we build (host as `domains`,
 * the token, and `ip`/`clear`), and that a non-`OK` body or non-200 throws — since
 * DuckDNS signals failure in the body, not the status code.
 */

function mockFetch(status: number, body: string) {
  const fn = vi.fn(async (_url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upsertAddress', () => {
  it('GETs the update endpoint with domains, token, and ip', async () => {
    const fetchFn = mockFetch(200, 'OK');
    await new DuckDnsProvider('tok-123').upsertAddress('myserver', '203.0.113.5');

    const url = new URL(fetchFn.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe('https://www.duckdns.org/update');
    expect(url.searchParams.get('domains')).toBe('myserver');
    expect(url.searchParams.get('token')).toBe('tok-123');
    expect(url.searchParams.get('ip')).toBe('203.0.113.5');
    expect(url.searchParams.get('clear')).toBeNull();
  });

  it('throws on a KO body even with a 200 status', async () => {
    mockFetch(200, 'KO');
    await expect(
      new DuckDnsProvider('tok').upsertAddress('myserver', '203.0.113.5'),
    ).rejects.toThrow(/DuckDNS update for "myserver" failed/);
  });

  it('throws on a non-200 status', async () => {
    mockFetch(500, 'OK');
    await expect(
      new DuckDnsProvider('tok').upsertAddress('myserver', '1.2.3.4'),
    ).rejects.toThrow(/500/);
  });
});

describe('removeAddress', () => {
  it('GETs the update endpoint with clear=true and no ip', async () => {
    const fetchFn = mockFetch(200, 'OK');
    await new DuckDnsProvider('tok-123').removeAddress('myserver');

    const url = new URL(fetchFn.mock.calls[0]![0]);
    expect(url.searchParams.get('domains')).toBe('myserver');
    expect(url.searchParams.get('clear')).toBe('true');
    expect(url.searchParams.get('ip')).toBeNull();
  });
});
