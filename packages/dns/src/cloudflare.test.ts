import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudflareDnsProvider } from './cloudflare.ts';

/**
 * Cloudflare adapter tests. We stub fetch and route by method+path, asserting the
 * FQDN (`<label>.<zone>`), that upsert creates a DNS-only record (proxied:false,
 * ttl:60) when none exists and PUTs the existing one otherwise, and that a
 * `success:false` envelope throws even on a 200.
 */

const ZONE = 'example.com';
const ZONE_ID = 'zone123';

/** A fetch stub that dispatches on `${METHOD} ${pathname}` via the given handlers. */
function routed(handlers: Record<string, (url: URL, init?: RequestInit) => unknown>) {
  const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    // Keys are written against the API path (after the /client/v4 base).
    const apiPath = url.pathname.replace(/^\/client\/v4/, '');
    const key = `${method} ${apiPath}`;
    const result = handlers[key]?.(url, init) ?? { success: true, result: [] };
    return { ok: true, status: 200, statusText: 'OK', json: async () => result };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('upsertAddress', () => {
  it('resolves the zone id, then POSTs a DNS-only A record when none exists', async () => {
    const { calls } = routed({
      [`GET /zones`]: () => ({ success: true, result: [{ id: ZONE_ID }] }),
      [`GET /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: [] }),
      [`POST /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: { id: 'rec1' } }),
    });

    await new CloudflareDnsProvider('tok', ZONE).upsertAddress('play', '203.0.113.5');

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      type: 'A',
      name: 'play.example.com',
      content: '203.0.113.5',
      ttl: 60,
      proxied: false,
    });
    // Zone id resolved from the zone name.
    const zoneLookup = calls.find((c) => c.url.pathname.endsWith('/zones'))!;
    expect(zoneLookup.url.searchParams.get('name')).toBe(ZONE);
  });

  it('PUTs the existing record when one is already there', async () => {
    const { calls } = routed({
      [`GET /zones`]: () => ({ success: true, result: [{ id: ZONE_ID }] }),
      [`GET /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: [{ id: 'rec9' }] }),
      [`PUT /zones/${ZONE_ID}/dns_records/rec9`]: () => ({ success: true, result: { id: 'rec9' } }),
    });

    await new CloudflareDnsProvider('tok', ZONE, { zoneId: ZONE_ID }).upsertAddress('play', '1.2.3.4');

    expect(calls.some((c) => c.method === 'PUT' && c.url.pathname.endsWith('/rec9'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('skips the zone lookup when zoneId is supplied', async () => {
    const { calls } = routed({
      [`GET /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: [] }),
      [`POST /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: {} }),
    });

    await new CloudflareDnsProvider('tok', ZONE, { zoneId: ZONE_ID }).upsertAddress('mc', '9.9.9.9');
    expect(calls.some((c) => c.url.pathname.endsWith('/zones'))).toBe(false);
  });

  it('throws on a success:false envelope even with a 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: false, errors: [{ message: 'bad token' }] }),
      })),
    );
    await expect(
      new CloudflareDnsProvider('tok', ZONE, { zoneId: ZONE_ID }).upsertAddress('play', '1.2.3.4'),
    ).rejects.toThrow(/bad token/);
  });
});

describe('removeAddress', () => {
  it('DELETEs the matching record', async () => {
    const { calls } = routed({
      [`GET /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: [{ id: 'rec9' }] }),
      [`DELETE /zones/${ZONE_ID}/dns_records/rec9`]: () => ({ success: true, result: { id: 'rec9' } }),
    });

    await new CloudflareDnsProvider('tok', ZONE, { zoneId: ZONE_ID }).removeAddress('play');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname.endsWith('/rec9'))).toBe(true);
  });

  it('is a no-op when there is no record to clear', async () => {
    const { calls } = routed({
      [`GET /zones/${ZONE_ID}/dns_records`]: () => ({ success: true, result: [] }),
    });

    await new CloudflareDnsProvider('tok', ZONE, { zoneId: ZONE_ID }).removeAddress('play');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
