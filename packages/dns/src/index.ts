/**
 * The DNS seam. A {@link DnsProvider} knows how to point a hostname at an IP and
 * (optionally) tear it down again. It is deliberately NOT part of the cloud
 * `ServerProvider`: folding DNS into the provider would force every future cloud
 * (AWS, …) to re-implement DuckDNS/Cloudflare. Interface + adapters live in this
 * one package (lighter than the cloud seam's api+impl split — extract later only if
 * a vendor SDK gets heavy).
 *
 * Capability tiers (epic #13):
 *  - single-host DDNS (DuckDNS, No-IP): one pre-registered hostname, A record only.
 *  - zone managers (Cloud DNS, Cloudflare, Route53): arbitrary records incl. SRV.
 * The optional methods let a richer adapter add capability without the single-host
 * ones having to pretend to support it.
 */

export interface SrvRecord {
  /** e.g. "minecraft" for _minecraft._tcp. */
  service: string;
  proto: 'tcp' | 'udp';
  port: number;
  priority?: number;
  weight?: number;
}

export interface DnsProvider {
  /** Create-or-replace the A record `host -> ip`. Implemented by every adapter. */
  upsertAddress(host: string, ip: string): Promise<void>;
  /** Remove the A record on stop, if the adapter supports it (hygiene — epic #13). */
  removeAddress?(host: string): Promise<void>;
  /** SRV record — zone managers only. Deferred (#12). */
  upsertService?(svc: SrvRecord, host: string): Promise<void>;
}

export { DuckDnsProvider } from './duckdns.ts';

/**
 * Pick a DNS adapter from env, or `undefined` when DNS is unconfigured — DNS is
 * opt-in, so an unset token means the worker/CLI skip all DNS work and every
 * command behaves exactly as before. v1 ships only DuckDNS (`DNS_PROVIDER`
 * defaults to `duckdns`); the token comes from `DUCKDNS_TOKEN` (Secret Manager in
 * production). Throws only on an explicit-but-broken config, never on "no DNS".
 */
export async function dnsProviderFromEnv(): Promise<DnsProvider | undefined> {
  const which = process.env.DNS_PROVIDER ?? 'duckdns';
  if (which === 'duckdns') {
    const token = process.env.DUCKDNS_TOKEN;
    if (!token) return undefined; // opt-in: no token => DNS disabled
    const { DuckDnsProvider } = await import('./duckdns.ts');
    return new DuckDnsProvider(token);
  }
  throw new Error(`Unknown DNS_PROVIDER "${which}" (v1 supports: duckdns)`);
}
