# Per-server / per-game firewall — implementation brief

Hand-off note for a fresh conversation. Goal: each game server opens **only its
own ports**, instead of every VM sharing one global firewall rule. This is the
prerequisite that unblocks built-in games (`create --game=<x>`), because a game
manifest's port list has to actually drive infra — see `IDEAS.md` discussion and
`docs/SHORTCUTS.md` #8.

## The cut we're fixing

Today there is **one shared rule** for all servers (`infra/main.tf`
`google_compute_firewall.game`, lines ~44–63):

- It targets `var.network_tag` (`"onehost"`) and opens the union of
  `var.game_tcp_ports` + `var.game_udp_ports` from `0.0.0.0/0`.
- **Every** game VM wears that single `onehost` tag (`packages/gcp/src/provider.ts`
  `tags: { items: [this.cfg.networkTag] }` at both insert sites — create ~line 121,
  start ~line 191), so every server gets every game's ports.
- The list is **static Terraform**. Adding a port (e.g. Enshrouded `15637/udp`)
  means hand-editing `terraform.tfvars` + `terraform apply`. A CLI `create` cannot
  mutate it at runtime. This is the wall hit during the enshrouded setup.

The SSH rule (`google_compute_firewall.ssh`, port 22, locked to
`var.ssh_source_ranges`) is fine and stays global — don't touch it.

## Recommended approach: provider-managed per-server firewall rules

Move game-port firewall out of static Terraform and into the provider, keyed by a
per-server network tag. Terraform can't be applied from a CLI `create`, so the
rule must be created dynamically in the same code path that already creates the
instance.

1. **Per-server tag.** Derive a stable tag from the server id, e.g.
   `onehost-srv-<id>` (sanitize to GCP's tag rules: lowercase, `[a-z0-9-]`, ≤63
   chars, start with a letter). Add a helper alongside `instanceName`/`diskName` in
   `provider.ts`.

2. **Attach both tags to the instance.** Change both insert sites to
   `tags: { items: [this.cfg.networkTag, serverTag(id)] }`. Keep the shared
   `onehost` tag so the global SSH rule still matches.

3. **Create the rule on `create`.** The ports are already known —
   `ServerSpec.ports` (`{ protocol, port }[]`, populated by the CLI `buildSpec`).
   In `create`, after deriving the tag, call `compute.firewalls.insert` to make a
   rule named `onehost-game-<id>` that targets `serverTag(id)`, opens only that
   server's tcp/udp ports, `source_ranges = ["0.0.0.0/0"]`. Use a global-op wait
   (firewalls are a global resource — mirror `waitGlobal`/`waitZonal` usage; check
   how snapshots wait, they're global too).

4. **Persist ports across stop/start.** `stop` deletes the instance + disk but the
   firewall rule should survive (it's keyed by id, cheap, and `start` recreates the
   instance with the same tag). Simplest: leave the rule in place across stop/start;
   only `destroy` removes it. Confirm `start` re-attaches `serverTag(id)` (step 2
   covers it). If you'd rather not leave orphan rules while stopped, recreate the
   rule in `start` too and delete in `stop` — but the persistent-rule path is
   simpler and the cost is ~$0.

5. **Delete on `destroy`.** Add `compute.firewalls.delete` for `onehost-game-<id>`
   to `destroy` (idempotent — ignore 404, like the existing not-found handling).

6. **Where do ports come from on `start`?** A bare `start <id>` has no spec. Either
   (a) leave the create-time rule untouched (step 4) so start needs no port info, or
   (b) stamp the ports onto a snapshot label at stop and read them back. (a) is much
   simpler — prefer it.

7. **Retire / repurpose the global game rule.** Drop `google_compute_firewall.game`
   (and `game_tcp_ports`/`game_udp_ports` vars + their tfvars entries), OR keep it
   behind a flag for a "shared ports" fallback. Removing it is cleaner once the
   provider owns per-server rules. Update `infra/variables.tf`, `terraform.tfvars`,
   `terraform.tfvars.example` accordingly.

### IAM
The provider's runtime identity (CLI = your ADC; worker = its SA) needs
`compute.firewalls.create/delete` (`roles/compute.securityAdmin` or a custom role).
The CLI path already has broad creds; for the **worker** SA, add the permission in
`infra/cloudrun.tf` if start/destroy ever runs off-box. (Today create/destroy are
CLI-only — verify whether the worker needs it before granting.)

## Alternative considered (don't, unless reasons change)
**Per-game shared rules** (one rule per game tag, e.g. `onehost-game-enshrouded`,
servers tagged by game): fewer rules, but you'd still need them created when a new
game first appears, and it leaks ports between same-game servers. Per-server is
barely more rules and is the correct granularity. Skip it.

## Ties into built-in games
Once ports are per-server and provider-driven, a game manifest can declare
`ports: [{udp:15637}]` and `create --game=enshrouded` just works with no
`terraform apply`. That's the payoff — but **this firewall change is
self-contained and worth doing on its own**; it doesn't require the game-catalog
work to land first.

## Acceptance check
- `create foo --port udp:15637` opens 15637/udp on `foo` only; a second server
  `bar` created without it cannot be reached on 15637.
- `stop foo` then `start foo` → still reachable on its port.
- `destroy foo` removes the `onehost-game-foo` rule (no orphan).
- SSH still works on all servers (global rule untouched).

## Key files
- `infra/main.tf` — the firewall rules to retire/keep.
- `infra/variables.tf`, `infra/terraform.tfvars(.example)` — port vars.
- `packages/gcp/src/provider.ts` — `create`/`start`/`destroy`, the `tags` blocks,
  add `serverTag()` + firewall insert/delete + global-op wait.
- `apps/cli/src/index.ts` — `buildSpec` already carries `ports`; the `--port` flag
  exists. Confirm it flows through.
- `docs/SHORTCUTS.md` #8 — mark resolved when done.
