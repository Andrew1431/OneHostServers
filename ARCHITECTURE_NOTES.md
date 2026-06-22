# Architecture Notes

Audit findings from a pass over the domain/provider/worker/CLI/jobs/dns/infra
surface and the test doubles. Ordered by severity, with `file:line`. Not yet
actioned — captured so they don't get lost.

## Functional inconsistencies (CLI command vs. server state)

### 1. Sweep auto-stop leaks the DNS A record — `packages/gcp/src/provider.ts:549`
`reconcile` auto-stops via `this.stop(...)` directly. DNS is off-box
(worker-side), so the record clear the worker does on a normal stop
(`apps/worker/src/handler.ts:97`) is bypassed. A cron-auto-stopped server keeps
its `host.duckdns.org` A record pointing at a now-freed ephemeral IP — exactly
the hazard epic #13 cites (players routed to whoever GCP reassigns the IP to).
The auto-stop path is the *most* likely to leak, since it targets forgotten
servers. Fix direction: have the worker's `sweep` case clear DNS for each
`report.stopped[].dnsHost` (requires `StaleServer` to carry `dnsHost`, or a list
lookup).

### 2. Raw vs. sanitized id divergence silently breaks lookups
`apps/worker/src/handler.ts:91,175`; `apps/cli/src/index.ts:109,157,164`;
`apps/cli/src/interactive.ts:388`

`GcpServerProvider.list()` returns the *sanitized* id (the label value,
`provider.ts:471`), but every consumer matches with
`list().find(s => s.id === rawId)`. For any non-canonical id (uppercase, `_`,
leading digit), these all silently miss:
- worker `stop`: `dnsHost` lookup returns undefined → **DNS never cleared**
- worker `start`: `startedEmbed` degrades to address-only
- CLI `status`/`dns`: misreport / skip the immediate record publish
  (`index.ts:164-166`)

The `/list` help says "id as shown by /list", which masks it in practice, but
it's a sharp edge. Canonicalize the id (via `sanitizeName`) before comparing.

### 3. Test doubles can't catch #2 and disagree with the real provider on auto-stop
`packages/testing/src/index.ts:234,255`
- `InMemoryProvider.list()` keys by raw `spec.id`, so all fake-backed tests pass
  non-canonical ids through cleanly — the divergence in #2 is structurally
  invisible to the suite.
- The fake's reconcile auto-stops whenever `autoStop > 0 && uptime >= autoStop`
  (`:255`), but the real provider *disables* auto-stop when
  `autoStopUptimeHours < maxUptimeHours` (`provider.ts:524-527`). The fake can
  assert behavior the real provider won't exhibit.

## Robustness / DevOps

### 4. No idempotency → redelivery shows false failures
`apps/worker/src/index.ts:111`, `provider.ts:231-292`

Worker timeout and Pub/Sub `ack_deadline` are both 600s
(`cloudrun.tf:179,252`). A start that runs longer redelivers while the first is
still in flight → concurrent `start` → `disks.insert` collides
(`ALREADY_EXISTS`), which is *not* a capacity error, so `withZoneFallback`
rethrows and Discord shows "failed" though the server is fine. Same for any
at-least-once redelivery of a completed start. Tracked as #17, but the
user-visible "scary failure on success" consequence is worth prioritizing. The
compensating `deleteDiskQuietly` (`:289`) also targets the in-use disk name on
this path — safe only because GCP rejects deleting an attached disk.

### 5. `mapInstanceStatus` collapses billing states to STOPPED — `provider.ts:822-835`
`REPAIRING`, `SUSPENDED`, and `TERMINATED` all fall through `default → STOPPED`.
A `REPAIRING`/`SUSPENDED` instance is still billing but reads STOPPED in
`status`/`list`, hiding cost and confusing the sweep (which only acts on
`RUNNING`, so a stuck-REPAIRING VM is never caught).

### 6. Lexicographic timestamp ordering — `provider.ts:498,782,803`
"Newest snapshot" is chosen by string-comparing GCP `creationTimestamp` (RFC3339
with a numeric TZ offset). Correct within one DST period; snapshots straddling a
DST transition (offset flips `-08:00`↔`-07:00`) can mis-order, picking a stale
restore point. Practically rare, but `new Date(ts).getTime()` removes the latent
bug for ~free.

### 7. Orphaned firewall rule when every zone is exhausted — `provider.ts:169` (before `withZoneFallback`)
`create` writes the ingress rule up front; if all zones return capacity errors,
the rule persists for a server that never existed. Reclaimed only by
`destroy <id>` (which a user is unlikely to run for a non-existent server). ~$0,
but a stray resource and a slow accumulation.

## Architectural notes

### 8. The lifecycle guard the docs lean on is not in the live path
`packages/core/src/state.ts`, `packages/state/src/index.ts`,
`apps/worker/src/index.ts:18-21`

`nextState`/`InvalidTransitionError`/`@onehost/state`/the `ERROR` state are
unwired; only the in-memory fake exercises `nextState`. Nothing in production
ever produces `ERROR` (failures throw; `status` returns `STOPPED`). This is
documented future work, but the comment "the control plane never mutates state
by hand — it asks `nextState`" reads as a current guarantee it isn't. Worth a
one-word "(planned)" so a future reader doesn't assume the guard is protecting
them.

### 9. `ssh` uses `shell: true` with passthrough args — `apps/cli/src/index.ts:121-125`
Needed for `gcloud.cmd` on Windows, and the args are the user's own argv (not a
privilege boundary), so not a vulnerability — but it's the one spot interpolating
user input into a shell. Fine to leave; noting for completeness.

## What's solid
Seam discipline is genuinely good: `provider-api`/`dns`/`jobs` are clean
interfaces, DNS deliberately kept off the cloud provider, sizing carried on
labels so the provider stays stateless (cloud-as-source-of-truth is consistent
across `list`/`status`/`stop`). The `init.consistency.test.ts` cross-file drift
guard and the `fakeGcp` recording fake are above-average for a project this size.
Pricing/catalog separation and the zone-fallback logic are well reasoned.

## Priority
Fix **#1** (real data-hygiene/security gap, contradicts a stated invariant) and
**#2** (silent, and currently untestable per #3) first.
