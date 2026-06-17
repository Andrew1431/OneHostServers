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

## Zone auto-discovery for stop / status / start / destroy — DONE

Resolved. `stop`/`status`/`destroy` resolve a server's actual zone via `locate`
(name-filtered aggregatedList) instead of trusting `GCP_ZONE`, and `list` uses
aggregatedList directly — so a server that capacity placed in a different zone
(the POC `mc` landed in `-b`, not the default `-a`) is still found. `create`/`start`
fall back across the region's zones (`withZoneFallback`), so `GCP_ZONE` is now just
the *preferred* placement, not a hard requirement. Remaining nice-to-have: see the
machine-substitution entry above for when *no* zone has the requested type.

## Substitute a similar machine type when a zone is out of capacity — NOT YET BUILT

`ZONE_RESOURCE_POOL_EXHAUSTED` now triggers a cross-zone retry (`withZoneFallback`),
but if *every* zone is out of the requested type, it still fails. Since the boot
disk is machine-agnostic, we could instead boot onto a *comparable* type that does
have stock — operational cost is low enough that a slightly different machine beats
"can't start".

- **Mechanics are nearly free:** `catalog.ts` `listMachineTypes(zone)` reads what a
  zone offers, and `start` already accepts a `machineType` override. So substitution
  is just choosing a different type to pass.
- **Hard part #1 — capacity is unobservable:** `listMachineTypes` returns what's
  *catalogued*, not what has stock right now; you only learn by attempting the
  insert. So this turns the current 1-D zone search into a 2-D (zone × type) search,
  each miss costing an insert→wait→rollback. Must be **bounded** to a short curated
  ladder, not "try everything".
- **Hard part #2 — "similar" needs a policy:** comparable vCPU/RAM within a tolerance
  plus a family preference (prefer same-or-faster cores: e2 → n2 → c2; core *speed*
  matters more than count for game servers). Custom types (`e2-custom-V-M`) widen the
  fallback space.
- **Hard part #3 — transient vs persisted:** `start` re-stamps the chosen type onto
  the snapshot labels, so a substitute would silently become the server's permanent
  spec. Prefer transient substitution (or at least notify the user it happened).
- **Layering:** keep zone fallback first; add the type ladder *within* each zone.

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

## Long-running-server nag — Discord ping when a VM has been up 8+ hours

A server left RUNNING for hours (someone forgot to `/stop`) burns money. Detect it
and nudge the channel.

- **Detection (no agent needed):** a periodic **reconcile sweep** — Cloud Scheduler
  → a Cloud Run/worker endpoint that runs `instances.list`/aggregatedList for
  `onehost`-labelled RUNNING VMs and reads each one's `lastStartTimestamp` (fall
  back to `creationTimestamp`). Uptime = now − that. Past a threshold (8h), notify.
  This is the same sweep IDEAS.md "Idle self-teardown" wants as a lost-signal
  backstop and SHORTCUTS #6 references — build once, serve both.
- **Notify:** these alerts have **no Discord `interactionToken`** (no slash command
  behind them), so the worker's `editOriginal` path doesn't apply. Post to a
  **channel webhook** (store its URL as a secret/env) instead — same gap the idle
  path has, so a `source` discriminator + webhook-notify branch on the `Job`/worker
  unblocks both.
- **Don't spam:** ping once per crossing, not every sweep. Cheapest is a dedup
  marker (e.g. stamp an `onehost-nagged-at` label on the instance once pinged;
  clear it on stop/start) so a 15-min sweep doesn't re-alert hourly.
- **Threshold config:** `ONEHOST_MAX_UPTIME_HOURS` (0 = off), mirroring
  `ONEHOST_SNAPSHOT_KEEP`. Optionally escalate (warn at 8h, auto-stop at 24h) —
  but auto-stop reuses the graceful `provider.stop`, so it's a small step from the
  nag once the sweep + webhook exist.

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
