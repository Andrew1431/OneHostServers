# OneHost

java -Xmx3G -jar server.jar nogui

On-demand, pay-only-for-what-you-play dedicated game servers you self-host in
your **own GCP project**. Spin up a VM, install any server software (Minecraft,
Valheim, Astroneer, …), and when nobody's playing it costs ~pennies — the disk
is snapshotted and the instance is deleted. Boot it back from a Discord command.

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
  worker       consume Job -> drive provider -> edit the Discord reply         [Cloud Run]
  agent        runs ON the game VM: idle-poll -> request stop
infra/         Terraform: network + firewall (main.tf) and the bot (cloudrun.tf)
SETUP.md           fresh clone -> working bot, step by step
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

```bash
pnpm install

# 1. Authenticate. Application Default Credentials is what the Node client uses.
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable compute.googleapis.com

# 2. Network + firewall (opens SSH + game ports on tagged VMs)
cd infra
cp terraform.tfvars.example terraform.tfvars   # edit project_id, lock SSH to your IP
terraform init && terraform apply
cd ..

# 3. Drive the lifecycle
export GCP_PROJECT_ID=YOUR_PROJECT_ID
export GCP_ZONE=us-central1-a

pnpm cli create mc --vcpus 2 --memory 4096 --disk 20 --port tcp:25565
# -> prints an IP. SSH in, install your Minecraft server, start it.
pnpm cli status mc
pnpm cli stop mc        # snapshots the disk, deletes the instance -> ~$0 idle
pnpm cli start mc       # restores from snapshot
pnpm cli destroy mc     # deletes everything incl. snapshots
```

> Windows PowerShell: use `$env:GCP_PROJECT_ID = "..."` instead of `export`.

## Cost model

- **Running**: GCP custom machine type, per-second. A 2 vCPU / 4 GB box ≈
  $0.05–0.07/hr.
- **Idle**: snapshot storage only (~$0.026/GB-month, incremental) — pennies.
- **Control plane**: serverless (Cloud Run + Pub/Sub + Firestore), scales to
  zero, within free tiers.

See `docs/SHORTCUTS.md` for what's intentionally unfinished.
