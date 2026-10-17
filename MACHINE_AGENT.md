# Machine agent & the on-VM lifecycle contract

What has to be true *inside* a OneHost game VM for stop/start to be safe. This is
the on-box counterpart to the off-box provider (`packages/gcp/src/provider.ts`)
and worker (`apps/worker`). Read it before baking a base image or standing up a
new server by hand.

OneHost never looks inside your disk — it snapshots and restores it whole (it's
game-agnostic by design). That makes the disk's **on-disk consistency at snapshot
time** entirely your responsibility. This doc is that contract.

> **The contract is about behavior, not technology.** Everything below is stated
> in terms of Docker Compose + systemd because that's the planned reproducible-boot
> convention (issue #14)
> and makes for a concrete sample — but nothing here *requires* Docker. The only
> real requirements are: (1) your game flushes/saves and exits cleanly when the OS
> shuts down (the ACPI window, below), and (2) — if you want self-teardown — the
> box can signal the control plane. Fulfill those with whatever fits: a bare-metal
> binary under systemd (like a vanilla Minecraft server), an OpenRC/init script,
> Podman, a raw process supervised however you like. Read the Docker examples as
> *one worked instance* of the contract, not as the contract itself.

## How a stop actually happens

`provider.stop` (driven by the CLI `stop` or the Discord `/stop`) runs, in order:

1. **Quiesce** — `instances.stop` sends the VM an **ACPI soft-off**. This is a
   real OS shutdown: the guest gets a grace window to stop services cleanly. The
   provider *waits* for the VM to reach `TERMINATED` before continuing.
2. **Snapshot** — the now-quiescent boot disk is snapshotted (labelled with the
   server id + sizing so `start` can restore it).
3. **Delete** — the instance and its boot disk are deleted. Idle cost → just the
   snapshot.
4. **Prune** — older snapshots beyond the keep-count (default **1**) are removed,
   only after the new one is READY.

Step 1 is the new graceful-shutdown step. Everything good about your snapshot
depends on your VM doing the right thing during that ACPI window. If your game
ignores the shutdown, GCP hard-cuts power after the window and you snapshot a
dirty disk (corrupt world saves, half-written DBs).

> The grace window is the guest's to manage. GCP's ACPI shutdown gives roughly
> ~90s before a hard power-off; you control how that time is spent via systemd
> (below). Respond *sooner* if you can — a clean exit lets the snapshot start
> immediately rather than waiting out the window.

## The one thing you must install: a graceful-stop unit

This is the load-bearing piece — **not a daemon, not Node, just a systemd unit**
that runs your game and stops it cleanly on OS shutdown. With this in place,
graceful stop works for the manual `stop`/`/stop` paths with **no agent process
running at all**.

The sample below uses a systemd unit driving Docker Compose (the SHORTCUTS #1
convention) in `/opt/onehost`. If you don't use Docker, the shape is identical —
swap `ExecStart`/`ExecStop` for however you start and cleanly stop your server
(e.g. a launch script and an RCON `save-all`+`stop` for bare-metal Minecraft).
What matters is that `ExecStop` drains and saves within the ACPI window, not that
it shells out to `docker`.

Assuming the game runs under Docker Compose:

```ini
# /etc/systemd/system/onehost-game.service
[Unit]
Description=OneHost game server
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/onehost
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose stop
# Give the container time to drain on ACPI soft-off. Keep this < the ~90s ACPI
# window so systemd finishes before GCP hard-cuts power.
TimeoutStopSec=80

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now onehost-game.service
```

On ACPI soft-off, systemd runs `ExecStop` → `docker compose stop` → **SIGTERM**
to the container, which gets its own `stop_grace_period` (set in
`docker-compose.yml`) before SIGKILL. So the chain is exactly the "send a signal,
let the process say when it's done" model:

```
instances.stop (ACPI) ─▶ systemd stop onehost-game ─▶ docker compose stop
                                                          └─▶ SIGTERM ─▶ game flushes/saves ─▶ exits
```

Make the game honor SIGTERM. Per-engine examples:

| Game | Honors SIGTERM cleanly? | Notes |
|------|------------------------|-------|
| Most Docker images | Yes, if PID 1 forwards signals | Use `init: true` or `tini` so SIGTERM reaches the process, not just the shell |
| Minecraft (vanilla/Paper) | Needs help | Wrap so SIGTERM triggers `save-all` + `stop` via RCON/stdin; raw `java` killed mid-write corrupts the world. Set `stop_grace_period: 60s` |
| Valheim / Project Zomboid / etc. | Usually yes | Verify the image traps SIGTERM; bump `stop_grace_period` if saves are large |

Verify before trusting it:

```bash
sudo systemctl stop onehost-game.service   # should drain, not kill
# then the real test:
gcloud compute instances stop <name> --zone <zone>   # full ACPI path
```

## Save history lives on the disk: interval backups

OneHost keeps **one** snapshot per server by default (`--keep-snapshots` /
`ONEHOST_SNAPSHOT_KEEP` to change). That snapshot is the *restore point*, not the
*history*. History — "roll back to before the creeper / the bad mod / the
crash-corrupted save" — is the box's job: the game (or a timer) writes rotating
backups **onto the same disk**, so every snapshot carries the whole backup set
with it. Restoring an older save is then a file copy over SSH, not a snapshot
juggle — and the snapshot stays one cheap incremental chain.

**Contract:** if the game supports it, a server SHOULD keep interval backups on
its disk, at a cadence and depth the operator chooses. Prefer, in order:

1. **The game's built-in backups**, when it has them — they know how to write a
   consistent copy while running. Turn them on and set interval/count.
2. **A systemd timer** that makes a consistent copy (pause saving → flush → copy
   → resume), when the game has a save-flush command but no backup feature.
3. **Nothing beyond the snapshot**, when neither exists — say so in the box's
   README so the operator knows the snapshot is the only restore point.

Operator preferences go in one on-box file the backup job reads, so changing
cadence is an SSH edit, never a rebuild:

```bash
# /opt/onehost/backup.env
BACKUP_INTERVAL=1h      # how often (systemd OnUnitActiveSec syntax)
BACKUP_KEEP=24          # how many rotations to keep on disk
BACKUP_DIR=/opt/onehost/backups
```

Rules that keep it safe:

- **Same disk, bounded.** Backups must rotate (`BACKUP_KEEP`) so they can't fill
  the disk — a full disk corrupts the live save, which is worse than no backup.
  Size the boot disk for live save × (`BACKUP_KEEP` + 1) plus headroom.
- **Consistent copies only.** Never `tar` a save the game is mid-write on; use the
  game's backup, or flush-and-pause first (below).
- **Skip when idle.** No players since the last backup → no new backup, so an
  empty server doesn't rotate good history out.
- **Not a replacement for the stop path.** The graceful-stop unit above still has
  to save cleanly on ACPI; backups cover *logical* damage, the stop covers the
  final state.

Per-game:

| Game | Built-in? | How |
|------|-----------|-----|
| Enshrouded (`mornedhels/enshrouded-server`) | Yes (image) | `BACKUP_CRON=0 * * * *`, `BACKUP_MAX_COUNT=24` in the compose env; the server also keeps its own rotating `-1…-N` save files |
| Palworld | Partial | Server writes periodic world backups under `Pal/Saved/SaveGames/0/<id>/backup/`; tune cadence in `PalWorldSettings.ini` or add a timer |
| Minecraft (vanilla/Paper) | No | Timer: RCON `save-off` → `save-all flush` → `tar` the `world*` dirs → `save-on` |
| Valheim | Yes | `-backups N -backupshort S -backuplong L` launch args |

Minecraft-style timer (the generic pattern for "flush command, no backup feature"):

```bash
#!/usr/bin/env bash
# /opt/onehost/backup.sh — run by onehost-backup.timer
set -euo pipefail
source /opt/onehost/backup.env
mkdir -p "$BACKUP_DIR"
rcon() { mcrcon -H 127.0.0.1 -p "$RCON_PASSWORD" "$@"; }

# Skip if nobody played since the last backup (marker touched by the idle probe or
# here when players > 0).
[[ "$(rcon list | grep -oE '[0-9]+ of' | cut -d' ' -f1)" -gt 0 || -f /run/onehost-played ]] || exit 0

rcon save-off "save-all flush"
trap 'rcon save-on' EXIT
tar czf "$BACKUP_DIR/world-$(date +%Y%m%d-%H%M).tar.gz" -C /opt/onehost/game world world_nether world_the_end
rm -f /run/onehost-played
ls -1t "$BACKUP_DIR"/world-*.tar.gz | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm --
```

```ini
# /etc/systemd/system/onehost-backup.service  (Type=oneshot, ExecStart=/opt/onehost/backup.sh)
# /etc/systemd/system/onehost-backup.timer    (OnUnitActiveSec=${BACKUP_INTERVAL}) → systemctl enable --now onehost-backup.timer
```

### Why one snapshot is enough (the risk trade)

- **Snapshot object corruption** — very unlikely. Snapshots are redundant,
  checksummed storage managed by GCP; losing one is a provider-level incident, not
  a routine failure mode.
- **Logical damage captured into the snapshot** — the realistic risk: a crash-
  corrupted world, a griefed base, a bad mod, a game update that mangles saves.
  The snapshot faithfully preserves the damage. On-disk backups cover exactly
  this: restore the snapshot, then roll the save back from `BACKUP_DIR`.
- **Filesystem-level damage** (hard power-cut past the ACPI window on a dirty
  disk) — the one case where on-disk backups go down with the ship. The
  graceful-stop unit is the defense; if you want belt-and-braces for a precious
  world, set `--keep-snapshots 2` (the extra one costs only the delta) or copy
  saves off-box now and then (`gcloud compute scp`).

## Optional: the idle agent (only if you want self-teardown)

Everything above makes *operator-initiated* stops graceful. The **idle
self-teardown** feature (idle self-teardown — issue #18) is separate: the VM
notices it's empty and asks the control plane to stop it. The VM **must not stop
itself** — `instances.delete` would kill the process mid-sequence and it'd need
broad GCP creds on an untrusted box. So the agent only **signals**; the off-box
worker runs the same `provider.stop` above (which already quiesces via ACPI).

**This does not need Node** — it's a few lines of bash on a systemd timer. GCE
images ship with `gcloud` and a metadata server, so signalling is free:

```bash
#!/usr/bin/env bash
# /opt/onehost/idle-check.sh — run by a systemd timer every minute.
set -euo pipefail

# The provider stamps `onehost-server-id` metadata on every create/start, so this
# resolves with no manual setup. (You can also keep it in a sourced config file.)
SERVER_ID="$(curl -s -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/onehost-server-id)"
IDLE_LIMIT_MIN=15
STATE_FILE=/run/onehost-empty-since

meta() { curl -s -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null; }

# Honor `start --persist`: the provider stamps `onehost-idle-disabled=1` for that
# run only (per-instance metadata, gone on the next plain start). When set, never
# self-stop — the operator explicitly asked to keep this box alive.
if [[ "$(meta onehost-idle-disabled)" == "1" ]]; then
  rm -f "$STATE_FILE"   # so the empty-timer starts clean once persist is lifted
  exit 0
fi

players="$(count_players)"   # ← your game probe; 0 = idle (see below)

if [[ "$players" -gt 0 ]]; then
  rm -f "$STATE_FILE"
  exit 0
fi

now=$(date +%s)
[[ -f "$STATE_FILE" ]] || echo "$now" > "$STATE_FILE"
empty_since=$(cat "$STATE_FILE")

if (( now - empty_since >= IDLE_LIMIT_MIN * 60 )); then
  # Signal the control plane. The attached `onehost-game-vm` SA (Terraform) holds
  # only roles/pubsub.publisher on this one topic — nothing that can touch
  # instances/disks/snapshots. The worker consumes this exact message and runs
  # provider.stop (verified end-to-end). The Job type has no `source` field today,
  # so don't add one — a plain {kind,id} is what's consumed.
  gcloud pubsub topics publish onehost-jobs \
    --message "{\"kind\":\"stop\",\"id\":\"${SERVER_ID}\"}"
  rm -f "$STATE_FILE"
fi
```

```ini
# /etc/systemd/system/onehost-idle.service  (Type=oneshot, ExecStart=/opt/onehost/idle-check.sh)
# /etc/systemd/system/onehost-idle.timer    (OnUnitActiveSec=60s)  → systemctl enable --now onehost-idle.timer
```

The `count_players` probe is the only game-specific part:

- **TCP games:** any established connection on the game port —
  `ss -tn state established "( sport = :25565 )" | tail -n +2 | wc -l`.
- **UDP games (Enshrouded, Valheim, …):** TCP connection-counting doesn't apply
  (UDP is connectionless). Use the server's own session output or a query. For
  Enshrouded we parse the container's "Session" block — each connected client is
  an `OperatingNormally` machine (m#0 is the server's own baseline):
  `docker logs --since 45s enshrouded | awk '/Session/{c=0} /OperatingNormally/{c++} END{print c+0}'`.
  Alternatives: `conntrack -L -p udp --dport <port>` (needs conntrack-tools), or a
  Steam A2S query.
- **Minecraft:** a Server List Ping or RCON `list` for the real count.

### Where the idle path stands (see issue #18)

The signal → teardown path **works end-to-end** (verified): a VM publishes
`{kind:stop,id}`, the push subscription delivers it, and the worker runs
`provider.stop` (ACPI → snapshot → delete). Idle stops now also **notify** —
`Job.interactionToken` is optional, and the worker posts tokenless results to the
channel webhook (`DISCORD_CHANNEL_WEBHOOK_URL`) instead of editing a Discord reply
— and the worker passes `allowAlreadyStopped`, so an idle stop racing a manual one
(or a Pub/Sub redelivery) reads as success rather than an error. Remaining rough
edges:

- **No authz/validation on the job body:** `parsePushBody` casts without checking,
  and the worker acts on whatever `id` arrives. Any principal that can publish to
  `onehost-jobs` can stop *any* server — so a compromised game box could stop
  others'. Per-server authz (bind the VM's SA/message to its own id) is the
  hardening.
- **Lost signal (backstop now built):** the publish is fire-and-forget, so a
  dropped message could leave a VM billing forever. A Cloud Scheduler
  reconcile sweep (`{kind:sweep}` → worker `provider.reconcile`) now catches it:
  any RUNNING server past `ONEHOST_MAX_UPTIME_HOURS` is flagged (and optionally
  auto-stopped via `ONEHOST_AUTOSTOP_UPTIME_HOURS`), regardless of whether its idle
  signal ever arrived.

## Quick checklist for a new VM

- [ ] Game runs under `/opt/onehost/docker-compose.yml`, container honors SIGTERM
      (`init: true` / `tini`, sensible `stop_grace_period`).
- [ ] `onehost-game.service` installed + enabled; `TimeoutStopSec` < ~90s.
- [ ] `gcloud compute instances stop` drains cleanly (manual test).
- [ ] Interval backups on the disk if the game supports them (built-in, or
      `onehost-backup.timer`), rotated by `/opt/onehost/backup.env`.
- [ ] *(only for idle self-teardown)* `onehost-idle.timer` + a `count_players`
      probe installed on the box.

Items 1–3 are required for safe snapshots; 4 is strongly recommended (save
history); 5 is only for self-teardown.

Provided automatically by the provider/Terraform (nothing to do by hand):

- Instance metadata `onehost-server-id` — stamped on every create/start.
- Instance metadata `onehost-idle-disabled` — stamped `1` only when `start --persist`
  is used (absent otherwise). The idle agent reads it and skips self-teardown for
  that run; it's per-instance, so the next plain `start` runs idle teardown again.
  Nothing else consumes it.
- The `onehost-game-vm` SA (`roles/pubsub.publisher` on `onehost-jobs`) — created
  by Terraform when the control plane is enabled, and attached to the VM by the
  provider when `GCP_GAME_VM_SA` is set. This is what lets the box signal at all.
