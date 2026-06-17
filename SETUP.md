# OneHost setup

From a fresh clone to a working Discord bot that boots on-demand game servers in
**your** GCP project. Follow the steps in order.

Every step is one of three kinds:

- 🔧 **bootstrap** — one-time `gcloud` prep that has to happen before Terraform
  (Cloud Run can't deploy an image that doesn't exist yet, so the registry +
  images come first).
- 📦 **terraform** — declares all the actual infrastructure. The bulk of the work.
- 🎮 **discord** — clicks in the Discord Developer Portal (an external service —
  nothing Terraform can do for you).

> Why isn't it *all* `terraform apply`? Three things aren't infrastructure:
> your credentials, the built container images, and the Discord app itself. See
> [the bottom of this file](#why-the-bootstrap-steps-arent-terraform).

## Prerequisites

- **Node 24 + pnpm** (`corepack enable`)
- **gcloud CLI**, authenticated — https://cloud.google.com/sdk/docs/install
- **Terraform** ≥ 1.6 — https://developer.hashicorp.com/terraform/install
- A **GCP project** with billing enabled
- A **Discord account** + a server you can manage

Pick a region/zone once and use it everywhere below. The examples use
`northamerica-northeast2` / `northamerica-northeast2-b` (Toronto, the region the
cost table is priced for). Swap in yours consistently.

```bash
export PROJECT=your-gcp-project-id
export REGION=northamerica-northeast2
export ZONE=northamerica-northeast2-b
```

---

## 1. 🔧 Authenticate

```bash
gcloud auth login                          # you, in a browser
gcloud auth application-default login      # the credentials the Node client uses
gcloud config set project $PROJECT
pnpm install
```

## 2. 🔧 Bootstrap the project

Enable the APIs and create the image registry. (Terraform re-asserts the runtime
APIs too; these are the ones needed *before* Terraform can run.)

```bash
gcloud services enable \
  compute.googleapis.com run.googleapis.com pubsub.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com

gcloud artifacts repositories create onehost \
  --repository-format=docker --location=$REGION \
  --description="OneHost control-plane images"
```

## 3. 📦 Build + push the images

Builds both Cloud Run images in the cloud — no local Docker needed.

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=$REGION .
```

Re-run this whenever you change `apps/interactions`, `apps/worker`, or any package
they use. (See [Updating](#updating) for redeploying after a rebuild.)

## 4. 🎮 Create the Discord app

In https://discord.com/developers/applications:

1. **New Application** → name it (e.g. "OneHost").
2. **General Information** → copy the **Application ID** and **Public Key**.
3. **Bot** → **Reset Token** → copy the **Bot Token**. Keep it private — it's used
   only to register commands (step 7), never at runtime.
4. **Installation** (or **OAuth2 → URL Generator**) → scopes `applications.commands`
   + `bot` → open the generated URL to add the app to your server.
5. In Discord, turn on Developer Mode (User Settings → Advanced). Right-click your
   target channel → **Copy Channel ID**, and your server → **Copy Server ID**
   (that's the **Guild ID**).

You now have: Application ID, Public Key, Bot Token, Channel ID, Guild ID.

## 5. 📦 Configure Terraform + the CLI

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
```

Edit `infra/terraform.tfvars`:

```hcl
project_id        = "your-gcp-project-id"
region            = "northamerica-northeast2"
default_zone      = "northamerica-northeast2-b"   # worker boots VMs here
ssh_source_ranges = ["YOUR.IP.ADD.RESS/32"]       # lock SSH to your IP
game_tcp_ports    = ["25565"]                     # e.g. Minecraft
game_udp_ports    = ["2456-2458"]                 # e.g. Valheim

enable_bot             = true  # turns on the Cloud Run + Pub/Sub stack below
discord_application_id = "…"   # from step 4
discord_public_key     = "…"   # from step 4
discord_channel_id     = "…"   # the one channel commands are allowed in

interactions_image = "northamerica-northeast2-docker.pkg.dev/PROJECT/onehost/interactions:latest"
worker_image       = "northamerica-northeast2-docker.pkg.dev/PROJECT/onehost/worker:latest"
```

Then point the CLI at the same project (writes a gitignored repo-root `.env`):

```bash
cd ..
pnpm cli config --project $PROJECT --zone $ZONE
```

## 6. 📦 Apply

```bash
cd infra
terraform init
terraform apply
cd ..
```

This builds **everything**: the network + firewall, both Cloud Run services, the
Pub/Sub topic + push subscription, the service accounts, and all the IAM. When it
finishes, note the **`interactions_url`** output.

## 7. 🎮 Wire up Discord

1. Back in the Developer Portal → **General Information** → set **Interactions
   Endpoint URL** to the `interactions_url` from step 6. Discord sends a PING to
   verify; the endpoint answers the handshake, so it saves immediately.
2. Register the slash commands (needs the Bot Token + Guild ID from step 4):

   ```bash
   DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=… \
     pnpm --filter @onehost/interactions register
   ```

3. Lock the app to one channel: **Server Settings → Integrations → OneHost →
   Channels** (and use role permissions for *who* can run it). The
   `DISCORD_CHANNEL_ID` guard in the endpoint backs this up.

## 8. Use it

First, create a server with the CLI and install your game over SSH — first boot is
hands-on (see `docs/SHORTCUTS.md` #1):

```bash
pnpm cli create mc --vcpus 2 --memory 4096 --disk 20 --port tcp:25565
# SSH in, install + start your game, then:
pnpm cli stop mc        # snapshots the disk, deletes the VM -> ~$0 idle
```

After that it's all Discord, in your locked channel:

- **`/list`** — every server + status + address (doubles as status)
- **`/start <id>`** — restores the snapshot, boots the VM, posts the IP
- **`/stop <id>`** — snapshots + deletes the VM (~$0 idle)

`<id>` is the server id from `/list` (or `pnpm cli list`). Provisioning
(create/destroy) stays CLI-only by design.

---

## Updating

After changing app/package code, rebuild (step 3), then roll the affected service
to a new revision (Cloud Run pins a digest, so a fresh `:latest` needs a new
revision):

```bash
gcloud run deploy onehost-worker \
  --image $REGION-docker.pkg.dev/$PROJECT/onehost/worker:latest --region $REGION
gcloud run deploy onehost-interactions \
  --image $REGION-docker.pkg.dev/$PROJECT/onehost/interactions:latest --region $REGION
```

Changing only Terraform (env vars, IAM, ports) is just `terraform apply`.

## Local dev (no GCP control plane)

Run both services locally; interactions posts jobs straight at the worker (the
`HttpPublisher` mirrors the Pub/Sub push envelope, so the worker path is identical
to production). Real `/start` still needs GCP creds.

```bash
# terminal 1 — worker on :8081
PORT=8081 DISCORD_APPLICATION_ID=… GCP_PROJECT_ID=… \
  pnpm --filter @onehost/worker dev

# terminal 2 — interactions on :8080, HTTP transport to the worker
PORT=8080 JOB_TRANSPORT=http WORKER_URL=http://localhost:8081 \
  DISCORD_PUBLIC_KEY=… DISCORD_APPLICATION_ID=… \
  pnpm --filter @onehost/interactions dev
```

Point Discord at the interactions port through a tunnel (`cloudflared` / `ngrok`).

## Why the bootstrap steps aren't Terraform

Terraform manages *infrastructure state*. Three parts of a deploy aren't infra:

- **Auth** is your personal credentials — Terraform consumes them, can't create them.
- **Building images** compiles an app artifact; Terraform references an image, it
  doesn't build one. This is the one genuinely extra step.
- **The Discord app** is an external SaaS.

The registry + API enablement *could* be Terraform resources, but Cloud Run can't
deploy without an existing image, and an image can't push without an existing
registry — so the registry must exist *before* the main apply. Putting it inside
the same Terraform would force a targeted apply just for the registry, then the
build, then a full apply: two applies and a special flag. A short bootstrap is
simpler. After it, Terraform owns everything else.
