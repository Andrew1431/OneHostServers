# Ideas

Backlog of features worth doing, not yet scheduled. Unlike `docs/SHORTCUTS.md`
(corners deliberately cut, with a known fix), these are net-new capabilities.
Keep entries short: the problem, the sketch, and any constraints we already know.

## Easy resize when recreating a server

Recreating a stopped server is the natural moment to change its sizing — bump
RAM, add vCPUs, switch disk type — and it should be a first-class, discoverable
action, not a buried flag.

- **Today:** the seam exists. `start <id> --machine <type> --disk-type <type>`
  overrides the sizing remembered on the snapshot labels, and re-stamps the new
  values so the next stop carries them forward (`apps/cli/src/index.ts`
  `parseStartOpts`, `packages/gcp/src/provider.ts` `start`).
- **Wanted:** an interactive picker that pulls live `machine-types list` /
  `disk-types list` from GCP for the server's zone, and possibly a dedicated
  `resize` verb so the intent reads clearly.
- **Constraint:** custom e2/n2 types are formulaic (`<family>-custom-<vcpus>-<memMB>`),
  not enumerable — the picker mixes a "custom" path with the listable predefined
  types. RAM must be 0.5–8 GB/vCPU in 256 MB steps.

## `cli init` — interactive first-run bootstrap

On a fresh clone, one command should stand the whole thing up: prompt the user
and generate both `infra/terraform.tfvars` and the repo-root `.env` so they
never hand-edit either.

- Pull choices from the local gcloud install: `gcloud projects list` for the
  project, `gcloud compute regions list` (and zones) for placement — present
  them as a pick-list rather than free text.
- Ask the game-port questions that feed `game_tcp_ports` / `game_udp_ports`, and
  the SSH source range (default to the caller's current public IP).
- Write `terraform.tfvars` (project_id, region, ssh_source_ranges, ports) and
  `.env` (GCP_PROJECT_ID, GCP_ZONE) in one pass, then print the next steps
  (`terraform apply`, `cli create`).
- **Constraint:** keep it non-destructive — if either file exists, diff/confirm
  before overwriting. Needs gcloud + ADC already present; degrade to plain text
  prompts if a list call fails.

## Zone auto-discovery for stop / status / start / destroy

`list` already finds servers in any zone via aggregatedList, but the per-server
commands still trust the configured `GCP_ZONE` and fail if a server landed
elsewhere (capacity can place it in a different zone than requested — the POC
server `mc` ended up in `-b`, not the default `-a`).

- Resolve a server's actual zone from the cloud (instance aggregatedList, or the
  zone recorded alongside its snapshot) instead of assuming `GCP_ZONE`.
- That demotes `GCP_ZONE` to just a *default for `create`* — every other command
  becomes zone-agnostic, removing a whole class of "server not found" confusion.
- Pairs naturally with recording the chosen zone per-server on create/stop so
  start can restore into a zone with capacity and remember where it went.

## Retry across zones on capacity exhaustion

GCP returns `ZONE_RESOURCE_POOL_EXHAUSTED` when the configured zone has no
capacity for the requested machine type (hit on the POC `mc` create in
`northamerica-northeast2-a`). Today that's a hard failure — the user must
manually change `GCP_ZONE` / `default_zone` and retry.

- **Sketch:** on create/start, catch `ZONE_RESOURCE_POOL_EXHAUSTED` (and the
  related `QUOTA_EXCEEDED`/stockout codes) and retry the same request across the
  other zones in the region (`-a` → `-b` → `-c`) before surfacing an error.
- **Cheap because** snapshots are global (`provider.ts` restore uses
  `global/snapshots/...`) and the external IP is ephemeral — nothing is pinned to
  a zone, so re-placing is just retrying the disk+instance insert elsewhere.
- **Pairs with** the *Zone auto-discovery* idea below: that records where a server
  actually landed so subsequent stop/status/destroy find it; this one is the
  create/start-time fallback that picks a zone with capacity in the first place.
- **Constraint:** enumerate the region's zones from GCP (`zones list`, filter by
  region) rather than hardcoding `-a/-b/-c`; demote `GCP_ZONE`/`default_zone` to a
  *preferred* zone, not a hard requirement.

## Idle self-teardown — how an instance triggers its own stop

The agent runs ON the game VM and detects idleness (`apps/agent`). The open
question is how that turns into a snapshot + disk/VM delete. Settled shape: the
VM **cannot run its own teardown** — `instances.delete` kills the process
mid-sequence (prune/state/notify never run), it would need compute-admin on an
untrusted game box, and a running disk snapshots dirty. So the agent only
*signals*; an off-box worker (`apps/worker` `handleJob`) does snapshot → delete →
prune → notify.

- **Clean ordering:** on-box agent gracefully stops the container first
  (`docker compose stop` / Minecraft `save-all`+`stop`) so the disk is quiescent,
  *then* signals; worker snapshots the still-running-but-idle VM and deletes it.
  Resolves SHORTCUTS #6 (snapshot lands before disk delete).
- **Recommended transport:** agent publishes a stop `Job` to the same Pub/Sub
  topic the Discord path uses — both now exist: topic `onehost-jobs`
  (`infra/cloudrun.tf`) and `@onehost/jobs` (`Job` type + `PubSubPublisher`), and
  the worker's `stop` branch (`apps/worker` `handleJob`) is already reused. VM SA
  needs only `pubsub.publisher` on that one topic. (Alt: authenticated HTTP to
  Cloud Run via metadata ID token — the current `STOP_ENDPOINT` skeleton.)
- **Open decisions (deferred, not yet chosen):**
  - Pub/Sub publish vs HTTP for the signal.
  - Whether to add a control-plane **reconcile sweep** (Cloud Scheduler lists
    RUNNING servers, stops any idle past threshold) as a backstop for a lost
    signal — SHORTCUTS #6 is fire-and-forget, so a dropped publish = a VM that
    bills forever. (GCE `max-run-duration` is a cruder hard ceiling.)
- **Schema gap:** an idle stop has no `interactionToken` — every `Job` variant in
  `@onehost/jobs` currently requires one, and the worker's `followUp` edits a
  waiting Discord interaction. Needs a nullable token + channel-webhook notify, or
  a `source: 'discord' | 'idle'` discriminator on the `Job`.
- **Idempotency gap:** `provider.stop` throws "not running" when the instance is
  already gone; an idle/retried/swept stop should treat "already stopped" as
  success. Relates to SHORTCUTS #5 idempotency keys.
- **Rejoin race:** player connects between signal and delete — acceptable in v1 if
  the container is stopped before signaling (server reads as down, user re-starts);
  otherwise worker re-checks player count before deleting.

## Stable address — a fixed IP or domain instead of a random one each start

Today create/start attach an **ephemeral** external IP (`provider.ts`
`networkInterface`, no `natIP`), and since stop/start deletes + recreates the
instance, the IP changes every cycle. Players want a constant address.

- **Same IP every time:** reserve a **regional static external IP** and set it as
  `natIP` on create/start. Stable across stop/start and across zones within the
  region. **Cost works against the idle-delete model:** GCP (Toronto SKUs) bills an
  external IPv4 at $0.005/hr while *attached to a running VM* (~$3.65/mo) but
  $0.011/hr while *reserved-but-unattached* (~$8/mo). Because OneHost deletes the
  VM when idle, a reserved static IP sits unattached most of the time → billed at
  the *higher* idle rate during exactly the periods the snapshot-delete model
  makes cheap. Budget ~$5–8/mo per server, skewing to $8 the more idle it is.
  There is no "static but only pay while on" — static = reserved 24/7; releasing
  it to avoid the idle charge loses the reservation (next start gets a new IP =
  ephemeral). Ephemeral (today) is $0.005/hr while running, $0 while idle.
- **Friendly name without buying a domain:** a free dynamic-DNS subdomain
  (DuckDNS / No-IP / afraid.org) — `foo.duckdns.org` — updated via API on each
  start once the new IP is known (agent/worker hits the DDNS update URL). $0.
- **Owned domain:** ~$10–15/yr; host in Cloud DNS (cheap) or registrar DNS. Lets
  you use an **SRV record** (e.g. Minecraft `_minecraft._tcp`) so players type just
  the domain and the port is hidden — DDNS providers usually can't do SRV.
- **Cleanest combo:** static IP **+** any DNS name pointed at it once. The static
  IP means the A record never needs per-start updates, sidestepping dynamic DNS
  entirely. A domain is **not** required; it only buys a nicer hostname / SRV.
