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

- [x] **Interactive `create`** — `create` with no sizing flags (or `-i`) in a TTY
  launches a `@clack/prompts` picker: gaming power-tier machine families (`e2` →
  `c4`) from the zone's live `machineTypes`/`diskTypes`, each annotated with an
  on-demand hourly cost estimate, then a confirm + provision. Custom sizing
  (`<family>-custom-V-M`) offered for e2/n2/n2d; shared-core types filtered out.
  Cost comes from a static per-family rate table sourced from the Billing Catalog
  for `northamerica-northeast2` (`packages/gcp/src/pricing.ts`) — region-specific,
  flagged as approximate elsewhere. (`apps/cli/src/interactive.ts`,
  `packages/gcp/src/catalog.ts`). Pairs with the resize picker in IDEAS.md entry 1.
- [x] **Discord bot** — the real product UX. Webhook (HTTP-interactions) bot with
  three commands: `/list` (also serves as status), `/start <id>`, `/stop <id>`.
  Provisioning stays CLI-only by design. `apps/interactions` verifies signatures,
  guards on `DISCORD_CHANNEL_ID`, and publishes a `Job` (`@onehost/jobs`) onto a
  Pub/Sub topic, ACKing Discord with a "⏳ working" message inside the 3s window.
  `apps/worker` consumes the push, drives the provider, and edits that same
  message in place with the result (IP on start). AuthZ is delegated to Discord's
  channel/role permissions (resolves SHORTCUTS #3); the Pub/Sub hand-off is now
  real (resolves SHORTCUTS #5's transport gap). Slash-command registration:
  `pnpm --filter @onehost/interactions register`. Cloud Run + Pub/Sub deploy in
  `infra/cloudrun.tf`; build/deploy steps in `docs/DEPLOY.md`. Local dev runs both
  services without GCP via `JOB_TRANSPORT=http`.

- [ ] **`cli init` first-run bootstrap** — generate `terraform.tfvars` + `.env`
  interactively from `gcloud projects/regions`. (IDEAS.md entry 2)
- [ ] **TUI dashboard** — optional polish now that the bot is the real UX.
