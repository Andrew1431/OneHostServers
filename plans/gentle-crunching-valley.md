# Plan: Stable address via DuckDNS (Epic #13 v1 — issues #7 + #8)

## Context

On-demand servers get an **ephemeral** external IP that changes on every start
(stop/start deletes + recreates the instance), so players have no constant
address. Epic #13 v1 fixes this with the **DuckDNS DDNS path**: on start, upsert
an A record `host.duckdns.org → new IP`; on stop, clear it. DuckDNS is free,
token-based, and fixes TTL at 60s, satisfying the epic's "low TTL so a restart
propagates fast" requirement inherently.

Two design constraints drive the shape:
- **DNS is its own seam (`packages/dns`)**, NOT part of `ServerProvider` — a future
  AWS provider must not re-implement DuckDNS/Cloudflare.
- **The worker only receives `{kind,id}` jobs and has no durable state** (Firestore
  is future). So, like machine/disk sizing today, the DuckDNS subdomain is
  **remembered as a GCP label** carried across stop/start. The provider only
  persists + echoes that opaque string; the actual DNS write happens in the worker
  (and CLI) via `@onehost/dns`. This keeps DNS out of the provider seam while
  fitting "the cloud is the source of truth, no DB."

**Opt-in:** no `--dns` at create (no label) and/or no `DUCKDNS_TOKEN` configured ⇒
feature is inert; every command behaves exactly as today. When enabled, `create`,
`start`, `status`, `list` (CLI) and the Discord embeds surface **both** the IP and
the `host.duckdns.org` name.

User-confirmed decisions: label-based host lookup; CLI also upserts on `create`;
include Terraform/Secret Manager wiring; strictly opt-in.

### Terminology: "upsert" = the DNS write, not GCP insert
`DnsProvider.upsertAddress(host, ip)` is create-or-replace of the **A record**. The
ephemeral IP changes on every boot, so the record is (re)written on **every boot**:
- **`start`** (worker, Discord-driven) — the primary path.
- **`create`** (CLI) — *also*, only because `create` boots a live RUNNING instance
  with a fresh IP immediately; without it a new server has no record until it cycles.

### Retrofitting existing servers (`mc`, `enshrouded`)
Those predate the feature and have **no `onehost-dns-host` label**, so the create-time
`--dns` flag can't reach them. Add a CLI-only **`dns` command** — the exact shape of
the existing `ports` command (`apps/cli/src/index.ts:123`, `provider.setPorts`): a
concrete provider method (NOT on the cloud-agnostic seam) that stamps/clears the
label, applied **live if running, picked up on next start if stopped**.

---

## 1. New package: `packages/dns` (issue #7)

`packages/dns/package.json` — mirror `provider-api` (no runtime deps; DuckDNS is
plain `fetch`). `private`, `type: module`, `main`/`exports` → `./src/index.ts`,
`typecheck` + `test` scripts, devDep `typescript` + `vitest`.

`packages/dns/src/index.ts`:
```ts
export interface SrvRecord { service: string; proto: 'tcp'|'udp'; port: number; priority?: number; weight?: number; }

export interface DnsProvider {
  upsertAddress(host: string, ip: string): Promise<void>;   // A record — all adapters
  removeAddress?(host: string): Promise<void>;              // on stop, if supported
  upsertService?(svc: SrvRecord, host: string): Promise<void>; // zone managers only — deferred (#12)
}

/** Pick a DNS adapter from env. Returns undefined when DNS is unconfigured
 *  (opt-in: the worker/CLI then skip all DNS work). v1: DuckDNS only. */
export function dnsProviderFromEnv(): DnsProvider | undefined;
```
- `dnsProviderFromEnv` returns `new DuckDnsProvider(token)` when `DUCKDNS_TOKEN`
  is set (selector `DNS_PROVIDER` defaults to `duckdns`), else `undefined`.

`packages/dns/src/duckdns.ts` — `DuckDnsProvider implements DnsProvider`:
- `upsertAddress(host, ip)` → `GET https://www.duckdns.org/update?domains={host}&token={token}&ip={ip}`.
- `removeAddress(host)` → same URL with `&clear=true` (no `ip`).
- `host` is the **subdomain label only** (e.g. `myserver`, not the full domain).
- Response body is `OK`/`KO`; throw a clear error on `KO` or non-200.

`packages/dns/src/duckdns.test.ts` — mock `fetch`: assert upsert URL/params,
clear URL on remove, and that `KO`/non-200 throws. (Pattern: vitest `vi.fn`.)

Add `@onehost/dns` to the pnpm workspace (already glob `packages/*`).

---

## 2. Core type + naming (issue #8 type half)

`packages/core/src/types.ts`:
```ts
export interface DnsSpec {
  provider: 'duckdns';   // adapter selector; v1 = duckdns
  hostname: string;      // subdomain label, e.g. 'myserver' for myserver.duckdns.org
}
export interface ServerSpec { /* …existing… */ dns?: DnsSpec; }
```
- Add `dnsHost?: string` to **`RunningServer`** and **`ServerSummary`** (opaque
  echo of the stored subdomain — directly mirrors how `machineType`/`diskType`
  already ride `ServerSummary`). Optional ⇒ no churn for non-DNS servers.

`packages/core/src/format.ts` — `ServerView` + `viewServer` (the single display
funnel for CLI `list`/`status` **and** the worker embeds): add
`dns: s.dnsHost ? \`${s.dnsHost}.duckdns.org\` : '—'`. One edit here is what makes
**every** surface show IP **and** DNS. Test in `format.test.ts`.

`packages/gcp/src/config.ts`: new `export const DNS_HOST_LABEL = 'onehost-dns-host';`
(DuckDNS subdomains are label-safe: lowercase alphanumeric + hyphens). Document it
beside `MACHINE_LABEL`.

---

## 3. GCP provider: stamp / carry / surface the label

`packages/gcp/src/provider.ts` — follow the existing `MACHINE_LABEL` pattern exactly:
- **`create`**: when `spec.dns?.hostname`, add `[DNS_HOST_LABEL]: spec.dns.hostname`
  to the instance `labels`; return `dnsHost` on the `RunningServer`.
- **`start`**: resolve host from the snapshot label (`snapshot.labels[DNS_HOST_LABEL]`),
  re-stamp it on the new instance labels, return it on `RunningServer`.
- **`stop`**: carry `instance.labels[DNS_HOST_LABEL]` into the snapshot `sizing`
  labels (so it survives, exactly like the machine/disk labels do).
- **`list`**: read `inst.labels?.[DNS_HOST_LABEL]` (live) and the snapshot label
  (STOPPED branch); set `dnsHost` on the summary when present.
- **`status`** already returns only `{state,address}` — leave as is (CLI `status`
  will do a `list().find()` for the host, or we extend status; see §5).
- **`setDnsHost(id, hostname?)`** — new **concrete CLI-only method** (alongside
  `setPorts`/`resolveSshTarget`, NOT on the `ServerProvider` seam). Stamps/clears
  `DNS_HOST_LABEL`:
  - running ⇒ `instances.setLabels` (uses the `labelFingerprint` from `locate`),
  - stopped ⇒ `snapshots.setLabels` on the latest snapshot (so `start` restores it).
  Mirrors `ports`: live now, or on next start. This is the retrofit path for
  `mc`/`enshrouded`.

Test: extend `packages/gcp/src/provider.test.ts` (recording-fake style) to assert
the label round-trips create→stop(snapshot)→start, surfaces on `list`, and that
`setDnsHost` stamps the instance (running) / latest snapshot (stopped).

---

## 4. Wire DNS into the worker (issue #8 worker half)

`apps/worker/src/handler.ts`:
- `WorkerDeps` gains optional `dns?: DnsProvider`.
- **`start` case**: `const running = await deps.provider.start(job.id)`. After
  success, if `deps.dns && running.dnsHost` → `await deps.dns.upsertAddress(running.dnsHost, running.address)`,
  wrapped **best-effort** (try/catch → `console.error`; the box is up, a DNS hiccup
  must not flip the reply to "failed"). Pass `running` into `startedEmbed` so it can
  render a **DNS field** (`host.duckdns.org`) alongside Address when present.
- **`stop` case**: before calling stop, read the host —
  `(await deps.provider.list()).find(s => s.id===job.id)?.dnsHost`. After a
  successful stop, if `deps.dns && host` → `await deps.dns.removeAddress?.(host)`
  (best-effort). Closes the stale-record reassignment window (#8 hygiene rationale).
- `startedEmbed`: add `{ name: 'DNS', value: \`\\`${host}.duckdns.org\\`\` }` when
  `dnsHost` is set. `listEmbed`: append the DNS name to each server's detail line
  when `s.dnsHost` is present.

`apps/worker/src/index.ts`: build `dns: dnsProviderFromEnv()` into `deps` (import
from `@onehost/dns`; add the workspace dep to `apps/worker/package.json`).

Tests: extend `apps/worker/src/handleJob.test.ts` — start upserts `(host, ip)`,
stop removes `host`, a thrown `upsertAddress` still yields the "is up" embed
(non-fatal), and the no-`dns` path is unchanged. Requires the in-memory provider
to carry `dnsHost` (next section).

`packages/testing/src/index.ts` (`InMemoryProvider`): add `dnsHost` to
`ServerEntry`/`SeedServer`, set it from `spec.dns?.hostname` in `create`, preserve
across stop/start, and echo on `RunningServer`/`list()` — so worker tests exercise
the real flow. Add a `setDnsHost(id, host?)` concrete method (matching the GCP one)
so CLI/interactive tests can drive the retrofit command off-cloud.

---

## 5. CLI: opt-in `--dns`, upsert on create, show IP + DNS everywhere

`apps/cli/src/parse.ts`: add `dns?: string` to `Flags`; parse `--dns <hostname>`
in `parseFlags`; `buildSpec` sets `dns: flags.dns ? { provider:'duckdns', hostname: flags.dns } : undefined`.
Validate the hostname is label-safe (reuse/extend `sanitizeName` rules — reject if
it isn't, rather than silently mangling). Tests in `parse.test.ts`.

`apps/cli/src/interactive.ts`: optional prompt for a DuckDNS hostname in
`createInteractively`; set `spec.dns`. Test in `interactive.test.ts`.

**New `dns` command** (retrofit for `mc`/`enshrouded`), modeled on `ports`
(`apps/cli/src/index.ts:123`):
- `pnpm cli dns <id> <hostname>` → `provider.setDnsHost(id, hostname)`, then
  best-effort `upsertAddress(hostname, address)` if the server is running + DNS is
  configured. Print `'<id>' now resolves at <host>.duckdns.org` + the "running
  applies live; stopped picks it up on next start" note (copy `ports`' wording).
- `pnpm cli dns <id> --clear` → `setDnsHost(id, undefined)` + best-effort
  `removeAddress(host)`.
Add to `CLAUDE.md` CLI synopsis + `usage()`.

`apps/cli/src/index.ts`:
- **`create`**: after `provider.create(spec)`, if `spec.dns` and
  `dnsProviderFromEnv()` is set → `upsertAddress(spec.dns.hostname, running.address)`
  (best-effort, warn on failure). Print `reachable at {address}` **and** a
  `DNS: {host}.duckdns.org` line when enabled.
- **`start`**: print the DNS line too — `running.dnsHost` is now populated.
- **`status`** / **`list`**: surface `dnsHost` via `viewServer` (§2) — `printServers`
  gets a `DNS` column; `status` appends ` / <host>.duckdns.org`. Add `@onehost/dns`
  to `apps/cli/package.json`.

`stop` (CLI) stays as-is for v1 (worker owns teardown); optionally clear via
`dnsProviderFromEnv()` too for symmetry — include it, best-effort, since the CLI is
the hands-on surface and has creds.

---

## 6. Infra + docs

- `infra/cloudrun.tf`: a `google_secret_manager_secret` (+ version placeholder) for
  `duckdns-token`, and inject it as `DUCKDNS_TOKEN` env on the **worker** Cloud Run
  service (mirror existing secret/env wiring there). Grant the worker SA
  `secretAccessor`. Interactions service does not need it.
- `SETUP.md`: document `DUCKDNS_TOKEN` (where to get it, that DNS is opt-in) and the
  `--dns` create flag.
- `CLAUDE.md`: add `--dns <hostname>` to the `create` synopsis and the new
  `dns <id> <hostname> | --clear` command (retrofit for existing servers).
- Update epic #13 / issues #7 #8: check the v1 boxes + comment with the
  label-based-host design note (post via `gh` after merge).

---

## Out of scope (tracked, not built)
Static reserved IP (#9), Cloud DNS (#10), Cloudflare (#11), SRV records (#12),
per-server provider selection (v1 is DuckDNS-global-from-env). The `DnsProvider`
interface and `dnsProviderFromEnv` selector leave clean drop-in points for all of them.

---

## Verification
1. `pnpm typecheck && pnpm test` (Turbo) — new dns adapter tests, gcp label
   round-trip, worker upsert/remove + non-fatal + no-dns paths, CLI parse tests
   all green.
2. **Local end-to-end (no GCP):** run `interactions` + `worker` with
   `JOB_TRANSPORT=http` and a real `DUCKDNS_TOKEN`; the worker uses the in-memory
   provider path? — actually it uses GCP. So local verification is via the unit
   tests + a manual DuckDNS check: temporarily call `DuckDnsProvider.upsertAddress`
   against a throwaway DuckDNS domain and confirm `dig host.duckdns.org` returns the
   IP, then `removeAddress` + confirm it clears.
3. **Opt-in regression:** with no `DUCKDNS_TOKEN` and no `--dns`, confirm
   `create`/`start`/`stop` output and the Discord embeds are byte-for-byte as before
   (DNS lines absent).
4. **Live smoke (gated, real GCP):** `pnpm cli create mc --dns mc-onehost`,
   `stop`, `start`; confirm the CLI prints both the new IP and `mc-onehost.duckdns.org`
   and that the A record follows the IP across the restart.
