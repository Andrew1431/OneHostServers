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
