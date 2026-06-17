# Deliberate v1 shortcuts

Every corner cut on purpose, with the future-refactor note. Each is contained
behind a package boundary so the fix is local. Add an entry here *before*
relying on a shortcut — never cut one silently.

| # | Shortcut | Where | Future refactor |
|---|----------|-------|-----------------|
| 1 | First-boot game install is manual SSH | operator workflow | `docker-compose.yml` convention auto-run on boot for reproducible snapshots |
| 2 | Single project / single zone | `@onehost/gcp` config | region routing + cross-region snapshot copies |
| 3 | ~~AuthZ = (planned) Discord role check~~ **RESOLVED (delegated)** | `apps/interactions` | AuthZ is delegated to Discord: commands registered to one channel + a `DISCORD_CHANNEL_ID` guard in the endpoint; who-can-run is Discord channel/role permissions. App-level RBAC + per-server ownership/ACL still a future refactor if needed |
| 4 | ~~No snapshot GC / retention~~ **RESOLVED** | `@onehost/gcp` | `stop` prunes to newest N (`snapshotKeep`, default 3). Still count-based only; age-out / size-cap policy can come later |
| 5 | Naive op polling; no idempotency keys (Pub/Sub hand-off now real) | `@onehost/gcp` ops, `apps/worker` | idempotency keys + retry/compensation. Pub/Sub publish/push is wired (`@onehost/jobs`); the worker acks (204) after processing so a redelivery can't re-run a VM op, but transient failures then aren't retried — proper idempotency keys close this |
| 6 | Idle agent signals stop fire-and-forget | `apps/agent` | confirm snapshot landed before worker deletes the disk |
| 7 | ~~Restored instances reuse a hardcoded machine type~~ **RESOLVED** | `@onehost/gcp` | machine + disk type now persisted as snapshot labels and restored on `start` (overridable via flags). Still no full `MachineSpec` in a DB — fine until Firestore lands |
| 8 | One shared firewall rule opens all game ports for all servers | `infra/main.tf` | per-server firewall scoping (each server opens only its own ports) |
| 9 | Internal packages run from `src` via tsx; no build step | all packages | bundle (tsup/esbuild) per app for Cloud Run deploy; add TS project references |
| 10 | `start` has no rollback — a failed instance insert orphans the restored disk | `@onehost/gcp` provider `start` | wrap the two-step restore in compensation: if the instance insert fails (e.g. `ZONE_RESOURCE_POOL_EXHAUSTED`), delete the just-created disk before throwing. Pairs with the cross-zone retry idea (retry the *pair* in the next zone). Until then a failed start leaves a billable unattached disk — see below |

## start partial-failure orphans a disk (#10)

`provider.ts` `start` restores in two steps: (1) `disks.insert` from the snapshot,
(2) `instances.insert` attaching it (`autoDelete: true`). `autoDelete` only fires
once the disk is *attached*, so if step 2 fails the step-1 disk is left unattached
and bills for its full provisioned size (~$0.20/GB-mo for pd-ssd) indefinitely.
Hit live: a `start`/create exhausted in `northamerica-northeast2-a` left an
unattached 20 GB `mc` disk there. Fix is a `try`/`catch` around step 2 that
deletes `diskName(id)` on failure; `create` is unaffected (single atomic insert
with an inline boot disk). A `cli prune-disks` / status warning for existing
orphans would also help operators clean up after the fact.

## No-build internal packages (#9)

Packages set `"main": "./src/index.ts"` and are consumed directly by `tsx`. This
keeps dev frictionless and the dependency graph honest. For deploying the Cloud
Run apps we'll add a per-app bundle step — the package boundaries already drawn
mean that's purely a packaging concern, not a code change.
