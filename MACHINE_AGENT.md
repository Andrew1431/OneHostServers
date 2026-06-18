# Machine agent & the on-VM lifecycle contract

What has to be true *inside* a OneHost game VM for stop/start to be safe. This is
the on-box counterpart to the off-box provider (`packages/gcp/src/provider.ts`)
and worker (`apps/worker`). Read it before baking a base image or standing up a
new server by hand.

OneHost never looks inside your disk — it snapshots and restores it whole (it's
game-agnostic by design). That makes the disk's **on-disk consistency at snapshot
time** entirely your responsibility. This doc is that contract.

## How a stop actually happens

`provider.stop` (driven by the CLI `stop` or the Discord `/stop`) runs, in order:

1. **Quiesce** — `instances.stop` sends the VM an **ACPI soft-off**. This is a
   real OS shutdown: the guest gets a grace window to stop services cleanly. The
   provider *waits* for the VM to reach `TERMINATED` before continuing.
2. **Snapshot** — the now-quiescent boot disk is snapshotted (labelled with the
   server id + sizing so `start` can restore it).
3. **Delete** — the instance and its boot disk are deleted. Idle cost → just the
   snapshot.
4. **Prune** — old snapshots beyond the keep-count are removed.

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

Assuming the game runs under Docker Compose (the SHORTCUTS #1 convention) in
`/opt/onehost`:

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

## Optional: the idle agent (only if you want self-teardown)

Everything above makes *operator-initiated* stops graceful. The **idle
self-teardown** feature (IDEAS.md "Idle self-teardown") is separate: the VM
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

### Where the idle path stands (see IDEAS.md / SHORTCUTS.md)

The signal → teardown path **works end-to-end** (verified): a VM publishes
`{kind:stop,id}`, the push subscription delivers it, and the worker runs
`provider.stop` (ACPI → snapshot → delete). Remaining rough edges:

- **No notify on idle stops:** an idle stop has no Discord `interactionToken`, so
  the worker's reply-edit is a silent no-op (the stop still happens). A
  channel-webhook notify path would surface idle teardowns.
- **No authz/validation on the job body:** `parsePushBody` casts without checking,
  and the worker acts on whatever `id` arrives. Any principal that can publish to
  `onehost-jobs` can stop *any* server — so a compromised game box could stop
  others'. Per-server authz (bind the VM's SA/message to its own id) is the
  hardening.
- **Idempotency:** an idle stop may race a manual one. The worker should call
  `provider.stop(id, { allowAlreadyStopped: true })` so "already gone" is success,
  not an error. (The provider supports the flag; the worker's stop branch doesn't
  pass it yet.)
- **Lost signal:** the publish is fire-and-forget (SHORTCUTS #6). A dropped
  message = a VM that bills forever; a control-plane reconcile sweep (Cloud
  Scheduler) is the planned backstop.

## Quick checklist for a new VM

- [ ] Game runs under `/opt/onehost/docker-compose.yml`, container honors SIGTERM
      (`init: true` / `tini`, sensible `stop_grace_period`).
- [ ] `onehost-game.service` installed + enabled; `TimeoutStopSec` < ~90s.
- [ ] `gcloud compute instances stop` drains cleanly (manual test).
- [ ] *(only for idle self-teardown)* `onehost-idle.timer` + a `count_players`
      probe installed on the box.

Items 1–3 are required for safe snapshots; 4 is only for self-teardown.

Provided automatically by the provider/Terraform (nothing to do by hand):

- Instance metadata `onehost-server-id` — stamped on every create/start.
- The `onehost-game-vm` SA (`roles/pubsub.publisher` on `onehost-jobs`) — created
  by Terraform when the control plane is enabled, and attached to the VM by the
  provider when `GCP_GAME_VM_SA` is set. This is what lets the box signal at all.
