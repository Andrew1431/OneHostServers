# OneHost

On-demand, pay-only-for-what-you-play dedicated game servers you self-host in
your **own GCP project**. Spin up a VM, install any server software (Minecraft,
Valheim, Astroneer, …), and when nobody's playing it costs ~pennies — the disk
is snapshotted and the instance is deleted. Boot it back from a Discord command.

> ⚠️ **Early stages, but functional.** Both vertical slices work end-to-end and
> the cost model is real, but this is a young project: rough edges, deliberate v1
> shortcuts (`docs/SHORTCUTS.md`), and breaking changes are expected. Run it in
> your own project, read what it does before pointing it at anything you care
> about, and expect to get your hands dirty.

> Status: two working vertical slices. The GCP lifecycle (`@onehost/gcp` +
> `@onehost/cli`) is the hands-on surface; the Discord bot (`apps/interactions` +
> `apps/worker`, joined by Pub/Sub) is the serverless control plane — `/list`,
> `/start <id>`, `/stop <id>`. Full setup in `SETUP.md`.

## Why

Tired of paying a monthly fee for a server you use 5–20 hours a month. OneHost
bills you (via your cloud provider) for seconds the VM actually runs, and
~$0 while it's off (snapshot storage only).

## Architecture

```
packages/
  core         pure domain: types + lifecycle state machine (no I/O)
  provider-api the cloud seam (interface only) — add AWS later = 1 new package
  gcp          GCP implementation: instances, disks, snapshots, labels
  state        persistence boundary (in-memory fake now, Firestore later)
  jobs         the control-plane hand-off: Job type + publisher (Pub/Sub | HTTP)
apps/
  cli          drive the GCP provider directly — the hands-on playground
  interactions Discord HTTP-interactions endpoint: verify + AuthZ + enqueue   [Cloud Run]
  worker       consume Job -> drive provider -> reply (Discord edit or webhook) [Cloud Run]
infra/         Terraform: network + firewall (main.tf); control plane + the
               reconcile-sweep cron (cloudrun.tf)
SETUP.md           fresh clone -> working bot, step by step
MACHINE_AGENT.md   on-VM contract: graceful stop + the optional idle agent
docs/SHORTCUTS.md  every deliberate v1 shortcut + its refactor note
```

Lifecycle is **disk snapshots**, so it's game-agnostic — OneHost never looks
inside the disk:

```
create : fresh disk from base image -> instance
stop   : snapshot disk -> delete instance (+disk)
start  : disk from latest snapshot -> instance
```

## Prerequisites

- Node 24 + pnpm (`corepack enable` or `npm i -g pnpm`)
- A GCP project with billing enabled
- `gcloud` CLI — https://cloud.google.com/sdk/docs/install
- `terraform` (for the network/firewall) — https://developer.hashicorp.com/terraform/install

## Quickstart (GCP hands-on)

This is the pure-CLI lifecycle — no Discord, no Cloud Run. For the full bot
(end-to-end order: `init` → `setup` → `build:images` → `terraform apply` →
`register`), follow **`SETUP.md`**.

```bash
pnpm install

# 1. Authenticate. Application Default Credentials is what the Node client uses.
gcloud auth login
gcloud auth application-default login

# 2. Configure. Interactively writes the repo-root .env (project/zone) AND
#    infra/terraform.tfvars (project, region, SSH IP, game ports) — no hand-editing.
pnpm cli init

# 3. Enable the API + stand up the network/firewall (opens SSH + game ports).
gcloud services enable compute.googleapis.com   # or `pnpm setup` for the full bot stack
cd infra && terraform init && terraform apply && cd ..

# 4. Drive the lifecycle (reads project/zone from the .env that `init` wrote).
pnpm cli create mc --vcpus 2 --memory 4096 --disk 20 --port tcp:25565
# -> prints an IP. SSH in, install your Minecraft server, start it.
pnpm cli status mc
pnpm cli stop mc        # snapshots the disk, deletes the instance -> ~$0 idle
pnpm cli start mc       # restores from snapshot
pnpm cli destroy mc     # deletes everything incl. snapshots
```

> Prefer not to use the interactive `init`? `cp infra/terraform.tfvars.example
> infra/terraform.tfvars` and edit it, then `pnpm cli config --project <id>
> --zone <zone>` to write the `.env` by hand.

## Cost model

- **Running**: GCP custom machine type, per-second. A 2 vCPU / 4 GB box ≈
  $0.05–0.07/hr.
- **Idle**: snapshot storage only (~$0.026/GB-month, incremental) — pennies.
- **Control plane**: serverless (Cloud Run + Pub/Sub + Firestore), scales to
  zero, within free tiers.

### Idle storage — `northamerica-northeast2` (Toronto)

While a server is stopped you pay only for the snapshot, at the region's standard
snapshot rate (~$0.026/GB-month). Snapshots are **incremental**, so in practice
you're billed for *changed* blocks, not the full disk — the table below is the
worst-case (a full disk's worth), i.e. the ceiling on a month of pure idle.

| Boot disk | Snapshot / month (ceiling) |
|-----------|----------------------------|
| 5 GB      | ~$0.13 |
| 10 GB     | ~$0.26 |
| 20 GB     | ~$0.52 |
| 50 GB     | ~$1.30 |

> Rates are for `northamerica-northeast2` and approximate — check the
> [GCP pricing page](https://cloud.google.com/compute/disks-image-pricing) for
> your region. Other regions differ; `northamerica-northeast2` is the region
> OneHost's cost table is priced for (`packages/gcp/src/pricing.ts`).

See `docs/SHORTCUTS.md` for what's intentionally unfinished.
