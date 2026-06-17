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

## No-build internal packages (#9)

Packages set `"main": "./src/index.ts"` and are consumed directly by `tsx`. This
keeps dev frictionless and the dependency graph honest. For deploying the Cloud
Run apps we'll add a per-app bundle step — the package boundaries already drawn
mean that's purely a packaging concern, not a code change.
