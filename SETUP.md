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

> **Shortcut:** `pnpm cli init` walks you through this whole file's config
> interactively — it lists your projects/regions/zones from gcloud and writes both
> `.env` and `infra/terraform.tfvars`. The steps below are the manual path (and
> what the Discord bot needs on top of what `init` writes).

## 2. 🔧 Bootstrap the project

Enable the APIs and create the image registry. (Terraform re-asserts the runtime
APIs too; these are the ones needed *before* Terraform can run.) `pnpm setup`
does both, reading project + region from the `.env` (`pnpm cli config` / `init`
writes it):

```bash
pnpm setup
```

<details><summary>What that runs (manual equivalent)</summary>

```bash
gcloud services enable \
  compute.googleapis.com run.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

gcloud artifacts repositories create onehost \
  --repository-format=docker --location=$REGION \
  --description="OneHost control-plane images"
```
</details>

## 3. 📦 Build + push the images

Builds both Cloud Run images in the cloud — no local Docker needed.

```bash
pnpm build:images
```

<details><summary>Manual equivalent</summary>

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=$REGION .
```
</details>

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
# Optional allowlists (defense-in-depth; Discord's Integrations perms are the gate).
discord_allowed_guild_ids   = ["…"]  # [] = any server the app is installed in
discord_allowed_channel_ids = []     # [] = any channel the server grants it
# Optional: channel webhook URLs so idle self-teardowns + the long-running-server
# sweep (no slash command behind them) get announced. [] = they run silently.
discord_channel_webhook_urls = ["…"]

# Optional: long-running-server sweep (Cloud Scheduler → worker). 0 = off (no
# scheduler created). Auto-stop is opt-in and reuses the graceful stop.
max_uptime_hours      = 0   # warn once a server is up this many hours
autostop_uptime_hours = 0   # also auto-stop at this many hours (0 = warn only)
# sweep_location = "northamerica-northeast1"  # only if var.region has no Cloud
#   Scheduler (e.g. northamerica-northeast2 / Toronto); it just publishes to the
#   global topic, so it need not match your compute region.

# Optional: stable address (DNS). Blank token = off (servers keep their bare
# ephemeral IP). When set, the token is stored in Secret Manager and the worker
# upserts an A record on start / clears it on stop. Per-server hostnames are
# chosen at `create --dns <subdomain>` (or `cli dns <id>`). Pick ONE provider —
# see "Stable address (DNS)" below for how to get each token.
dns_provider = "duckdns"   # "duckdns" | "cloudflare"
duckdns_token = ""         # dns_provider = "duckdns"
# cloudflare_api_token = ""            # dns_provider = "cloudflare"
# cloudflare_zone      = "yourdomain.com"
# cloudflare_zone_id   = ""            # optional; skips the zone name -> id lookup

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
2. Register the slash commands. Put the Bot Token + Guild ID from step 4 (and the
   Application ID) in the repo-root `.env` — `DISCORD_APPLICATION_ID`,
   `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_IDS` (comma-separated; leave empty to
   register globally for every server the app is in, ~1h to propagate) — then just:

   ```bash
   pnpm register
   ```

   (`register` reads them from `.env`; nothing needs to go on the command line.)

3. Decide who can run it — in Discord, per server: **Server Settings →
   Integrations → OneHost** → channel and role overrides (e.g. turn All Channels
   off and allow just `#game-servers`). Commands are visible to everyone by
   default; set `DISCORD_COMMANDS_LOCKED=1` before `pnpm register` to start them
   hidden from non-Administrators instead. To add OneHost to another server, invite the app there, add its
   guild id to `DISCORD_GUILD_IDS` (or register globally), re-run `pnpm register`,
   and grant it the same way. The `discord_allowed_*` Terraform lists are an
   optional extra lock on top.

## 8. Use it

First, create a server with the CLI and install your game over SSH — first boot is
hands-on (reproducible-provisioning is planned — issue #14):

```bash
pnpm cli create mc --vcpus 2 --memory 4096 --disk 20 --port tcp:25565
# SSH in, install + start your game, then:
pnpm cli stop mc        # gracefully shuts down, snapshots the disk, deletes the VM -> ~$0 idle
```

While SSHed in, set up the **graceful-stop contract** so snapshots are taken from
a quiescent disk (clean world saves, no corruption): a systemd unit that stops
your game container on OS shutdown. `stop`/`/stop` trigger an ACPI soft-off and
wait for it. See **[`MACHINE_AGENT.md`](MACHINE_AGENT.md)** for the unit file,
per-engine SIGTERM notes, and the optional bash idle-agent (no Node needed).

After that it's all Discord, in your locked channel:

- **`/list`** — every server + status + address (doubles as status)
- **`/start <id>`** — restores the snapshot, boots the VM, posts the IP
- **`/stop <id>`** — snapshots + deletes the VM (~$0 idle)

`<id>` is the server id from `/list` (or `pnpm cli list`). Provisioning
(create/destroy) stays CLI-only by design.

---

## Stable address (DNS)

**Optional.** By default a server gets a fresh ephemeral IP every `start`, so
players need the new IP each time. Turn this on and OneHost keeps a hostname
pointed at the current IP: it upserts an A record on `create`/`start` and clears
it on `stop`. Records use a 60s TTL so a restart's new IP propagates fast.

It's off unless a token is set, and it's driven by a single seam
(`@onehost/dns`) with two backends selected by `DNS_PROVIDER`. Pick one:

### Option A — Cloudflare (you own a domain)

Best if you already have a domain on Cloudflare. You set the zone once and each
server is a subdomain under it: `create --dns play` → `play.yourdomain.com`.

1. **Get a scoped API token.** Cloudflare dashboard → **My Profile → API Tokens
   → Create Token → Create Custom Token**. Give it:
   - **Permissions:** `Zone` · `DNS` · `Edit`
   - **Zone Resources:** `Include` · `Specific zone` · *yourdomain.com*

   Create it and copy the token (shown once).
2. **Point config at it.** For CLI use, the repo-root `.env` (which you've
   already started):

   ```bash
   DNS_PROVIDER=cloudflare
   CLOUDFLARE_API_TOKEN=your-token
   CLOUDFLARE_ZONE=yourdomain.com
   # CLOUDFLARE_ZONE_ID=…        # optional; skips one API lookup per run
   ```

   That's everything the CLI needs — nothing else. For the **deployed Discord
   bot**, put the same values in `infra/terraform.tfvars` (`dns_provider`,
   `cloudflare_api_token`, `cloudflare_zone`) and `terraform apply`; the token
   goes to Secret Manager and is injected into the worker.

Because game traffic (UDP / arbitrary TCP) can't go through Cloudflare's HTTP
proxy, OneHost writes records **DNS-only** (grey cloud, not proxied) — don't flip
them to proxied in the dashboard.

### Option B — DuckDNS (no domain needed)

Free single-hostname DDNS. Register a subdomain at
<https://www.duckdns.org>, then set `DNS_PROVIDER=duckdns` (the default) and
`DUCKDNS_TOKEN=…` in `.env` (or `duckdns_token` in tfvars). A server's `--dns`
value is your DuckDNS subdomain label.

### Using it (either provider)

```bash
pnpm cli create mc --port tcp:25565 --dns mc   # name it at create time
pnpm cli dns mc mc                              # or attach/retarget on an existing server
pnpm cli dns mc --clear                         # remove the record
pnpm cli status mc                              # shows the hostname next to the IP
```

DNS is best-effort: if a record update fails, the server still starts and the
command still succeeds — you just fall back to the raw IP for that run.

---

## Updating

What you touched decides what you run:

| You changed… | Run |
|---|---|
| **App/package code** (`apps/worker`, `apps/interactions`, or a package they import — e.g. `@onehost/core`) | `pnpm run deploy` |
| **Slash command shape** (`apps/interactions/src/register.ts`) | `pnpm register` |
| **Terraform only** (env vars, IAM, ports, `default_zone`) | `terraform apply` |
| **CLI code** (`apps/cli`, or a package it imports) | nothing to deploy — the CLI runs from source via `tsx` |

`pnpm run deploy` reads your project + zone from `.env`, builds both images in the
cloud, and rolls the Cloud Run services — no `$REGION`/`$PROJECT` to set. (Use
`run` — a bare `pnpm deploy` triggers pnpm's own built-in command instead.)

```bash
pnpm run deploy                 # build + redeploy both services
pnpm run deploy worker          # only the worker (or: interactions)
pnpm run deploy --skip-build    # already built — just roll the latest image
```

(Cloud Run pins an image digest, so a fresh `:latest` needs a new revision; the
deploy rolls it for you.) Only the service whose code changed needs a redeploy —
but a shared package (`@onehost/core`, `@onehost/jobs`) touches both, so plain
`pnpm deploy` is the safe default. CLI and the deployed apps share one provider
(`@onehost/gcp`) and one renderer (`@onehost/core` `viewServer`), so a logic or
formatting change lands everywhere from a single edit — deploying only ships it
to Cloud Run.

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
