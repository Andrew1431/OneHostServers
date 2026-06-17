# Deliberate v1 shortcuts

Every corner cut on purpose, with the future-refactor note. Each is contained
behind a package boundary so the fix is local. Add an entry here *before*
relying on a shortcut — never cut one silently.

| # | Shortcut | Where | Future refactor |
|---|----------|-------|-----------------|
| 1 | First-boot game install is manual SSH | operator workflow | `docker-compose.yml` convention auto-run on boot for reproducible snapshots |
| 2 | Single project / single zone | `@onehost/gcp` config | region routing + cross-region snapshot copies |
| 3 | AuthZ = (planned) Discord role check only | `apps/interactions` | real RBAC + per-server ownership/ACL |
| 4 | No snapshot GC / retention | `@onehost/gcp` | lifecycle policy (keep N, age-out old snapshots) |
| 5 | Naive op polling; no idempotency keys; Pub/Sub hand-off is a TODO log line | `@onehost/gcp` ops, `apps/interactions`, `apps/worker` | idempotency keys + retry/compensation; real Pub/Sub publish |
| 6 | Idle agent signals stop fire-and-forget | `apps/agent` | confirm snapshot landed before worker deletes the disk |
| 7 | ~~Restored instances reuse a hardcoded machine type~~ **RESOLVED** | `@onehost/gcp` | machine + disk type now persisted as snapshot labels and restored on `start` (overridable via flags). Still no full `MachineSpec` in a DB — fine until Firestore lands |
| 8 | One shared firewall rule opens all game ports for all servers | `infra/main.tf` | per-server firewall scoping (each server opens only its own ports) |
| 9 | Internal packages run from `src` via tsx; no build step | all packages | bundle (tsup/esbuild) per app for Cloud Run deploy; add TS project references |

## No-build internal packages (#9)

Packages set `"main": "./src/index.ts"` and are consumed directly by `tsx`. This
keeps dev frictionless and the dependency graph honest. For deploying the Cloud
Run apps we'll add a per-app bundle step — the package boundaries already drawn
mean that's purely a packaging concern, not a code change.
