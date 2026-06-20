import type { DnsProvider } from './index.ts';

/**
 * DuckDNS adapter (v1). Free, token-based, no monthly re-confirmation or host-count
 * nag (strictly better than No-IP). The whole API is one GET to
 * `https://www.duckdns.org/update`:
 *  - upsert: `?domains=<host>&token=<token>&ip=<ip>`
 *  - clear:  `?domains=<host>&token=<token>&clear=true`
 * It answers with a body of `OK` or `KO`. DuckDNS fixes the record TTL at 60s, so
 * the epic's "low TTL so a restart's new IP propagates fast" requirement is met
 * inherently — there is no TTL knob to set.
 *
 * `host` is the subdomain *label* only (`myserver`, not `myserver.duckdns.org`),
 * which is what DuckDNS's `domains` param expects.
 */
export class DuckDnsProvider implements DnsProvider {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://www.duckdns.org/update',
  ) {}

  async upsertAddress(host: string, ip: string): Promise<void> {
    await this.call(host, { ip });
  }

  async removeAddress(host: string): Promise<void> {
    await this.call(host, { clear: 'true' });
  }

  /** One DuckDNS update call. `extra` carries either `ip` (upsert) or `clear`. */
  private async call(host: string, extra: Record<string, string>): Promise<void> {
    const params = new URLSearchParams({ domains: host, token: this.token, ...extra });
    const url = `${this.baseUrl}?${params.toString()}`;
    const res = await fetch(url);
    const body = (await res.text()).trim();
    // DuckDNS returns 200 with a textual OK/KO even on failure, so check the body,
    // not just the status. Never log the URL (it carries the token).
    if (!res.ok || body !== 'OK') {
      throw new Error(`DuckDNS update for "${host}" failed: ${res.status} "${body}"`);
    }
  }
}
