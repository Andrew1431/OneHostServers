# Deploying the Discord bot

The bot is two Cloud Run services joined by a Pub/Sub topic:

```
Discord --HTTPS--> interactions --publish--> onehost-jobs --push--> worker
                       |                       (topic)               |
                    3s ACK                                    drives the GCP
                  "⏳ working"                               provider, then edits
                                                          the Discord reply (IP)
```

`interactions` must answer Discord within 3 seconds; starting a VM takes minutes,
so it publishes a job and returns. The `worker` does the slow work and edits the
original "⏳ working" message in place using the interaction token (valid 15 min).

Cost is effectively **$0**: both services scale to zero and the message volume
sits inside the Pub/Sub + Cloud Run free tiers. The only real spend is the game
VMs themselves. See the README cost model.

## 0. Prerequisites

- The base infra applied already (`infra/main.tf` — network + firewall).
- `gcloud` authenticated, project set, billing on.
- A Discord application (https://discord.com/developers/applications). Note its
  **Application ID** and **Public Key** (General Information), and create a **Bot**
  to get a **Bot Token** (used only for command registration, step 3).

## 1. Create an Artifact Registry repo and build + push the images

```bash
REGION=us-central1
PROJECT=$(gcloud config get-value project)
REPO=$REGION-docker.pkg.dev/$PROJECT/onehost

gcloud artifacts repositories create onehost \
  --repository-format=docker --location=$REGION
gcloud auth configure-docker $REGION-docker.pkg.dev

# Build context is the repo ROOT for both (workspace deps span packages).
docker build -f apps/interactions/Dockerfile -t $REPO/interactions:latest .
docker build -f apps/worker/Dockerfile       -t $REPO/worker:latest .
docker push $REPO/interactions:latest
docker push $REPO/worker:latest
```

## 2. Apply the Cloud Run + Pub/Sub stack

Add to `infra/terraform.tfvars` (see `terraform.tfvars.example`):

```hcl
default_zone           = "us-central1-a"
discord_application_id = "…"
discord_public_key     = "…"
discord_channel_id     = "…"   # the one channel commands are allowed in
interactions_image     = "us-central1-docker.pkg.dev/PROJECT/onehost/interactions:latest"
worker_image           = "us-central1-docker.pkg.dev/PROJECT/onehost/worker:latest"
```

```bash
cd infra
terraform apply
# note the `interactions_url` output
cd ..
```

Set Discord's **Interactions Endpoint URL** (Developer Portal → your app → General)
to the `interactions_url` output. Discord sends a PING to verify; the endpoint
answers the handshake, so it saves immediately.

## 3. Register the slash commands

One-off (and again whenever the command set changes). Needs the bot token:

```bash
DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=… \
  pnpm --filter @onehost/interactions register
```

In Discord, restrict the app to one channel: **Server Settings → Integrations →
your app → Channels** (and use role permissions for who can run it). The
`DISCORD_CHANNEL_ID` guard in the endpoint backs this up.

## 4. Use it

In that channel: `/list`, `/start <id>`, `/stop <id>`. `/list` doubles as status.
`<id>` is the server id from the CLI (`pnpm cli list`). Create/destroy stay
CLI-only — first boot needs a hands-on SSH game install (SHORTCUTS #1).

## Updating

Rebuild + push the image(s), then redeploy that service. Cloud Run v2 picks up a
new `:latest` only on a new revision — bump the image tag (or run
`gcloud run deploy onehost-worker --image …`) rather than relying on `:latest`.

## Local dev (no GCP control plane)

Run both services and have interactions post jobs straight at the worker:

```bash
# terminal 1 — worker on :8081 (needs GCP creds for real start/stop)
PORT=8081 DISCORD_APPLICATION_ID=… GCP_PROJECT_ID=… \
  pnpm --filter @onehost/worker dev

# terminal 2 — interactions on :8080, HTTP transport to the worker
PORT=8080 JOB_TRANSPORT=http WORKER_URL=http://localhost:8081 \
  DISCORD_PUBLIC_KEY=… DISCORD_APPLICATION_ID=… \
  pnpm --filter @onehost/interactions dev
```

Point Discord at the interactions URL through a tunnel (e.g. `cloudflared` /
`ngrok`). The `HttpPublisher` mirrors the Pub/Sub push envelope, so the worker
code path is identical to production.
