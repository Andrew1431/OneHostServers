# Roadmap

CLI/UX work in priority order. Net-new feature sketches live in `IDEAS.md`;
deliberately-cut corners live in `docs/SHORTCUTS.md`. This file is the running
order of what to build next.

## Done

- [x] **`.env` config** — set `GCP_PROJECT_ID` / `GCP_ZONE` once instead of every
  command. `pnpm cli config --project <id> [--zone <zone>]` writes a gitignored
  repo-root `.env`; real env vars still override it. (`apps/cli/src/config.ts`)
- [x] **`onehost list`** — every server across all zones (live instances +
  STOPPED servers that exist only as snapshots), no DB needed. Also surfaces the
  real zone a server landed in. (`packages/gcp/src/provider.ts` `list`)
- [x] **Zone auto-discovery for stop / status / destroy** — these no longer trust
  `GCP_ZONE`; a `locate()` helper finds the instance across all zones first, so a
  server placed elsewhere by capacity (e.g. `mc` in `-b`) is handled cleanly.
  `GCP_ZONE` is now just the *default zone for `create`*. (`provider.ts` `locate`)
- [x] **Snapshot GC on stop** — `stop` prunes to the newest N snapshots per server
  (`pruneSnapshots`). N defaults to `DEFAULT_SNAPSHOT_KEEP` (3); override with
  `ONEHOST_SNAPSHOT_KEEP` / `cli config --keep-snapshots <n>`. Config-driven on
  `GcpConfig.snapshotKeep` so a future per-server/GUI setting feeds the same knob;
  `<= 0` keeps everything. (resolves SHORTCUTS.md #4)

## Later

- [ ] **Interactive `create`** — pick machine/disk from live GCP lists (e.g.
  `@clack/prompts`) instead of remembering flag syntax. Pairs with the resize
  picker in IDEAS.md entry 1.
- [ ] **`cli init` first-run bootstrap** — generate `terraform.tfvars` + `.env`
  interactively from `gcloud projects/regions`. (IDEAS.md entry 2)
- [ ] **Discord bot** — the real product UX; full TUI dashboard is optional polish.
