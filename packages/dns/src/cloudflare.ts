import type { DnsProvider } from './index.ts';

/**
 * Cloudflare adapter (zone-manager tier, epic #13). Unlike DuckDNS (one
 * pre-registered host under `duckdns.org`), Cloudflare manages records inside a
 * zone you own — so the deployment fixes the zone once (`CLOUDFLARE_ZONE`, e.g.
 * `mydomain.com`) and each server contributes a subdomain *label* (`play` ->
 * `play.mydomain.com`). The label is exactly what DuckDNS stores, so per-server
 * storage and the `--dns`/GCP-label round-trip are unchanged; only the suffix
 * differs.
 *
 * Records are written **DNS-only** (`proxied: false`): Cloudflare's proxy only
 * fronts HTTP/S, and game traffic (UDP/arbitrary TCP) must reach the origin IP
 * directly. TTL is pinned low (60s) so a new IP after a stop/start propagates
 * fast — the epic's fast-failover requirement, same as DuckDNS's fixed 60s.
 *
 * Auth is a scoped API token (`Authorization: Bearer …`) with Zone:DNS:Edit on
 * the zone. The zone id is resolved from the zone name on first use and cached;
 * pass `zoneId` to skip the lookup.
 */
export class CloudflareDnsProvider implements DnsProvider {
  private zoneIdPromise?: Promise<string>;

  constructor(
    private readonly token: string,
    private readonly zone: string,
    opts: { zoneId?: string; baseUrl?: string } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    if (opts.zoneId) this.zoneIdPromise = Promise.resolve(opts.zoneId);
  }

  private readonly baseUrl: string;

  async upsertAddress(host: string, ip: string): Promise<void> {
    const zoneId = await this.zoneId();
    const name = this.fqdn(host);
    const existing = await this.findRecordId(zoneId, name);
    const body = JSON.stringify({ type: 'A', name, content: ip, ttl: 60, proxied: false });
    if (existing) {
      await this.request('PUT', `/zones/${zoneId}/dns_records/${existing}`, body);
    } else {
      await this.request('POST', `/zones/${zoneId}/dns_records`, body);
    }
  }

  async removeAddress(host: string): Promise<void> {
    const zoneId = await this.zoneId();
    const id = await this.findRecordId(zoneId, this.fqdn(host));
    if (!id) return; // already gone — nothing to clear
    await this.request('DELETE', `/zones/${zoneId}/dns_records/${id}`);
  }

  private fqdn(host: string): string {
    return `${host}.${this.zone}`;
  }

  /** Resolve (and cache) the zone id from the zone name. */
  private zoneId(): Promise<string> {
    if (!this.zoneIdPromise) {
      this.zoneIdPromise = (async () => {
        const res = await this.request(
          'GET',
          `/zones?name=${encodeURIComponent(this.zone)}`,
        );
        const id = res.result?.[0]?.id;
        if (!id) throw new Error(`Cloudflare zone "${this.zone}" not found (check the token's zone access)`);
        return id as string;
      })();
    }
    return this.zoneIdPromise;
  }

  /** The id of the existing A record at `name`, or undefined if there is none. */
  private async findRecordId(zoneId: string, name: string): Promise<string | undefined> {
    const res = await this.request(
      'GET',
      `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    );
    return res.result?.[0]?.id;
  }

  /**
   * One Cloudflare API call. Cloudflare returns `{ success, errors, result }`;
   * failures come back with `success:false` (and sometimes a non-2xx), so check
   * the envelope, not just the status. Never log the token.
   */
  private async request(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ result?: any }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: Array<{ code?: number; message?: string }>;
      result?: any;
    };
    if (!res.ok || json.success === false) {
      const detail = json.errors?.map((e) => e.message).filter(Boolean).join('; ') || res.statusText;
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed: ${res.status} ${detail}`);
    }
    return json;
  }
}
