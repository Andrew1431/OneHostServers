# Deliberate v1 shortcuts

Every corner cut on purpose, with the future-refactor note. Each is contained
behind a package boundary so the fix is local. Add an entry here *before*
relying on a shortcut — never cut one silently.

| # | Shortcut | Where | Future refactor |
|---|----------|-------|-----------------|
| 1 | First-boot game install is manual SSH | operator workflow | `docker-compose.yml` convention auto-run on boot for reproducible snapshots |
| 2 | Single project / single region (multi-zone within it) | `@onehost/gcp` config | **Multi-zone DONE** — discovery and create/start capacity fallback span the region's zones. Open: cross-region routing + cross-region snapshot copies (still single-region, single-project) |
| 3 | ~~AuthZ = Discord role check~~ **RESOLVED (delegated)** | `apps/interactions` | AuthZ delegated to Discord (channel/role permissions + a `DISCORD_CHANNEL_ID` guard). Open: app-level RBAC + per-server ownership/ACL if ever needed |
| 4 | ~~No snapshot GC / retention~~ **RESOLVED** | `@onehost/gcp` | `stop` prunes to the newest N (`snapshotKeep`). Open: age-out / size-cap policy beyond count-based |
| 5 | Naive op polling; no idempotency keys | `@onehost/gcp` ops, `apps/worker` | Pub/Sub publish/push is wired and the worker acks (204) after processing, so a redelivery can't re-run a VM op — but transient failures then aren't retried. Open: real idempotency keys + retry/compensation |
| 6 | Idle stop signal is fire-and-forget | agent (MACHINE_AGENT.md) + `apps/worker` | **DONE:** graceful ACPI quiesce before snapshot (consistent disk); idle signal→teardown works end-to-end (VM publishes `{kind:stop,id}`; worker runs `provider.stop`); tokenless jobs now notify a channel webhook (`DISCORD_CHANNEL_WEBHOOK_URL`); worker passes `allowAlreadyStopped` so idle/manual races + Pub/Sub redeliveries read as success. Open for the *idle* path: (a) dropped publish = a VM that bills forever → needs a reconcile-sweep backstop; (c) no per-server authz on the job body (any topic publisher can stop any `id`) |
| 7 | ~~Restored instances reuse a hardcoded machine type~~ **RESOLVED** | `@onehost/gcp` | Machine + disk type persisted as snapshot labels and restored on `start` (flag-overridable). Open: full `MachineSpec` in a DB (when Firestore lands) |
| 8 | One shared firewall rule opens all game ports for all servers | `infra/main.tf` | per-server firewall scoping (each server opens only its own ports) |
| 9 | Internal packages run from `src` via tsx; no build step | all packages | bundle (tsup/esbuild) per app for Cloud Run deploy; add TS project references |
| 10 | ~~`start` has no rollback — a failed instance insert orphans the restored disk~~ **RESOLVED** | `@onehost/gcp` provider `start` | Failed insert now deletes the just-created disk (`deleteDiskQuietly`), folded into the cross-zone retry so each zone cleans up before the next. Open: `cli prune-disks` for *pre-existing* orphans |

## No-build internal packages (#9)

Packages set `"main": "./src/index.ts"` and are consumed directly by `tsx`. This
keeps dev frictionless and the dependency graph honest. For deploying the Cloud
Run apps we'll add a per-app bundle step — the package boundaries already drawn
mean that's purely a packaging concern, not a code change.
