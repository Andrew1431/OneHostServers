# OneHost

On-demand, pay-only-for-what-you-play dedicated game servers self-hosted in the
user's **own GCP project**. Game-agnostic by design: OneHost never looks inside
the disk — it snapshots and restores the whole boot disk.

- `create` : fresh disk from base image → instance
- `stop`   : ACPI quiesce → snapshot disk → delete instance (+disk) → ~$0 idle
- `start`  : disk from latest snapshot → instance

pnpm 9 monorepo, Node ≥20, Turbo. Internal packages run from `src` via `tsx` —
**no build step** (issue #4); only the two Cloud Run apps get bundled at deploy.

## Layout

```
packages/
  core         pure domain: types + lifecycle state machine (no I/O)
  provider-api the cloud seam (interface only) — add AWS later = 1 new package
  gcp          GCP impl: instances, disks, snapshots, labels, pricing/catalog
  state        persistence boundary (in-memory fake now, Firestore later)
  jobs         control-plane hand-off: Job type + publisher (Pub/Sub | HTTP)
apps/
  cli          drive the GCP provider directly — the hands-on surface
  interactions Discord HTTP-interactions endpoint: verify + AuthZ + enqueue  [Cloud Run]
  worker       consume Job → drive provider → reply (Discord edit or webhook) [Cloud Run]
infra/         Terraform: network/firewall (main.tf); control plane + reconcile-sweep cron (cloudrun.tf)
```

Planned work, feature sketches, and deliberate v1 cuts are tracked as
[GitHub issues](https://github.com/Andrew1431/OneHostServers/issues) (labelled by
origin/type/priority; `epic` issues group related work). Read the open issues
before starting work. Full fresh-clone→working-bot walkthrough: `SETUP.md`.
Per-server firewall + `--port` syntax reference: `docs/PER_GAME_PORTS.md`.

## CLI commands

Driven by `apps/cli/src/index.ts` against the GCP provider. Config comes from the
repo-root `.env` (`GCP_PROJECT_ID` required, `GCP_ZONE` default `us-central1-a`).

```
pnpm cli init                                  # first-run: writes .env + infra/terraform.tfvars interactively
pnpm cli config --project <id> [--zone <z>] [--keep-snapshots <n>]
pnpm cli create [<id>]                          # interactive picker in a TTY (machine tier + cost estimate)
pnpm cli create <id> [--vcpus 2] [--memory 4096] [--disk 20] [--disk-type pd-balanced] [--machine n2-standard-4] [--port tcp:25565]
pnpm cli start <id>   [--machine c2-standard-4] [--disk-type pd-ssd] [--disk 40]   # overrides upgrade on restore
pnpm cli start <id>   [-i|--interactive]        # pick machine/disk override from a menu (plain start restores remembered sizing)
pnpm cli stop <id>                              # ACPI quiesce → snapshot → delete instance+disk
pnpm cli ports <id> [--port udp:15636-15637] [--port tcp:80,443]   # set open ports (CLI-only); ranges N-M + lists N,M ok; no --port clears them
pnpm cli status <id>
pnpm cli list                                   # all servers, all zones (live + snapshot-only)
pnpm cli ssh <id> [-- <remote cmd>]             # hands off to user's `gcloud compute ssh`
pnpm cli sweep [--max-uptime <h>] [--autostop <h>]   # flag/auto-stop long-running servers (the cron's manual trigger)
pnpm cli destroy <id>                           # deletes instance, disk, and snapshots
```

disk types: `pd-standard` (HDD) | `pd-balanced` (SSD) | `pd-ssd` (fast SSD).
`--machine` overrides `--vcpus`/`--memory`.

## Build & deploy (control-plane apps)

Cloud Run images built **in the cloud** (no local Docker) via `cloudbuild.yaml`.
Order for a fresh project: `init` → `setup` → `build:images` → `terraform apply`
→ `register` (see `SETUP.md`).

```
pnpm setup            # one-time: enable GCP APIs + create the "onehost" Artifact Registry repo
pnpm build:images     # build+push both images (standalone build for initial setup, before first apply)
pnpm deploy           # build + roll BOTH Cloud Run services (use `pnpm run deploy`, not bare `pnpm deploy`)
pnpm run deploy worker | interactions     # build + roll one service
pnpm run deploy --skip-build              # roll latest image(s), skip build
pnpm prune-images     # GC old Artifact Registry image versions
pnpm register         # register Discord slash commands (@onehost/interactions)
```

Repo-wide: `pnpm typecheck` and `pnpm test` (both via Turbo).

Local dev without GCP: run `interactions` + `worker` with `JOB_TRANSPORT=http`.

## Setting up a new dedicated server (on-VM contract)

When the topic is **standing up a new game VM by hand / baking a base image /
what must be true inside the box for stop-start to be safe**, read
**`MACHINE_AGENT.md`**. It is the on-box counterpart to the off-box provider
(`packages/gcp/src/provider.ts`) + worker. Key points it covers: the graceful-stop
systemd unit (load-bearing — clean save/exit within GCP's ~90s ACPI window), making
the game honor SIGTERM, and the optional idle self-teardown agent (signals the
control plane via Pub/Sub; the VM must never stop itself).
