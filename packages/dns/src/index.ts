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
export { CloudflareDnsProvider } from './cloudflare.ts';

/** Adapter names the deployment can select via `DNS_PROVIDER`. */
export type DnsProviderName = 'duckdns' | 'cloudflare';

/** The configured adapter name (env), defaulting to DuckDNS. */
export function dnsProviderName(): DnsProviderName {
  return process.env.DNS_PROVIDER === 'cloudflare' ? 'cloudflare' : 'duckdns';
}

/**
 * The domain suffix records live under, derived from env — `duckdns.org`, or the
 * Cloudflare zone (`CLOUDFLARE_ZONE`). Used purely for *display*: callers build
 * `<label>.<suffix>` so the CLI/bot can print a server's stable name without
 * instantiating an adapter. Returns undefined when it can't be determined (e.g.
 * Cloudflare selected but `CLOUDFLARE_ZONE` unset), in which case callers fall
 * back to showing the bare label.
 */
export function dnsDomainSuffix(): string | undefined {
  if (dnsProviderName() === 'cloudflare') return process.env.CLOUDFLARE_ZONE || undefined;
  return 'duckdns.org';
}

/** Build the full hostname for a stored subdomain label, e.g. `play` -> `play.mydomain.com`. */
export function dnsFqdn(host: string): string {
  const suffix = dnsDomainSuffix();
  return suffix ? `${host}.${suffix}` : host;
}

/**
 * Pick a DNS adapter from env, or `undefined` when DNS is unconfigured — DNS is
 * opt-in, so an unset token means the worker/CLI skip all DNS work and every
 * command behaves exactly as before. `DNS_PROVIDER` selects the adapter
 * (defaults to `duckdns`):
 *  - `duckdns`    — `DUCKDNS_TOKEN`
 *  - `cloudflare` — `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE` (optional
 *                   `CLOUDFLARE_ZONE_ID` to skip the name→id lookup)
 * Secrets come from Secret Manager in production. Throws only on an
 * explicit-but-broken config, never on "no DNS".
 */
export async function dnsProviderFromEnv(): Promise<DnsProvider | undefined> {
  const which = dnsProviderName();
  if (which === 'duckdns') {
    const token = process.env.DUCKDNS_TOKEN;
    if (!token) return undefined; // opt-in: no token => DNS disabled
    const { DuckDnsProvider } = await import('./duckdns.ts');
    return new DuckDnsProvider(token);
  }
  if (which === 'cloudflare') {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) return undefined; // opt-in: no token => DNS disabled
    const zone = process.env.CLOUDFLARE_ZONE;
    if (!zone) throw new Error('DNS_PROVIDER=cloudflare needs CLOUDFLARE_ZONE (the domain you own, e.g. mydomain.com)');
    const { CloudflareDnsProvider } = await import('./cloudflare.ts');
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    return new CloudflareDnsProvider(token, zone, zoneId ? { zoneId } : {});
  }
  throw new Error(`Unknown DNS_PROVIDER "${which}" (supported: duckdns, cloudflare)`);
}
