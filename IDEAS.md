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

Resolved (see SHORTCUTS #2). Lifecycle ops discover a server's actual zone rather
than trusting `GCP_ZONE`, and create/start fall back across the region's zones on
capacity — `GCP_ZONE` is now just preferred placement. Remaining nice-to-have:
the machine-substitution entry above, for when *no* zone has the requested type.

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

## Idle self-teardown — how an instance triggers its own stop — MOSTLY DONE

Core path works end-to-end (see SHORTCUTS #6 and MACHINE_AGENT.md "Where the idle
path stands"). The on-VM agent (bash `idle-check.sh` on a systemd timer) gracefully
stops the container, then **signals only** — it never runs its own teardown
(`instances.delete` would kill it mid-sequence and need compute-admin on an
untrusted box). It publishes a `{kind:stop,id}` `Job` to the `onehost-jobs` topic
with its powerless `onehost-game-vm` SA (`pubsub.publisher` only); the off-box
worker runs `provider.stop` (ACPI quiesce → snapshot → delete → prune).

Recently closed: tokenless jobs now notify a channel webhook
(`DISCORD_CHANNEL_WEBHOOK_URL`; `Job.interactionToken` is optional and the worker's
`notify` routes by its presence), and the worker passes `allowAlreadyStopped` so an
idle/manual stop race (or a Pub/Sub redelivery) reads as success.

Remaining open work (also tracked in SHORTCUTS #6):

- **No authz on the job body:** any topic publisher can stop any `id`; bind the
  VM's SA/message to its own id.

The **lost-signal backstop** is now built — see "Long-running-server nag" below;
the same reconcile sweep that nags also catches a VM whose self-stop signal was
dropped (it eventually crosses the uptime ceiling).
- **Rejoin race:** player connects between signal and delete — acceptable in v1
  since the container is stopped before signaling (reads as down, user re-starts).

## Long-running-server nag — Discord ping when a VM has been up too long — DONE

A server left RUNNING for hours (someone forgot to `/stop`) burns money. Built as a
**reconcile sweep** that doubles as the idle lost-signal backstop (SHORTCUTS #6).

- **Detection:** Cloud Scheduler publishes `{kind:sweep}` onto the `onehost-jobs`
  topic on a cron (`sweep_schedule`, default every 15 min); the existing push
  subscription delivers it to the worker, which calls `provider.reconcile`. That
  reads `lastStartTimestamp` (else `creationTimestamp`) for each `onehost`-labelled
  RUNNING VM and acts on any past `ONEHOST_MAX_UPTIME_HOURS`. No new endpoint/auth —
  reuses the whole Pub/Sub path. (`packages/gcp/src/provider.ts` `reconcile`,
  `infra/cloudrun.tf` `google_cloud_scheduler_job.sweep`.)
- **Notify:** tokenless, so it posts to the channel webhook
  (`DISCORD_CHANNEL_WEBHOOK_URL`) — the same path the idle teardown uses.
- **Don't spam:** the sweep stamps an `onehost-nagged-at` label once it warns about
  an instance; later passes skip it. Stop/start clears it naturally (the instance
  is deleted/recreated), so each run re-arms.
- **Escalation:** `ONEHOST_AUTOSTOP_UPTIME_HOURS` (0 / below max = warn only) makes
  the sweep auto-stop via the graceful `provider.stop` once a server is up that long.
- **Remaining nice-to-haves:** per-server thresholds (vs the single global env);
  GCE `max-run-duration` as a cruder hard ceiling for belt-and-suspenders.

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
