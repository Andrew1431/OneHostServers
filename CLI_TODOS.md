# CLI TODOs

Running notes for the `apps/cli` surface. Not a contract — just a scratchpad for
follow-ups we hit while driving the provider by hand.

## Lifecycle ops should hand off to the worker, not run in-process

Today the CLI drives `provider.stop` (and start/create) directly in the Node
process. If the operator closes the terminal mid-`stop`, the sequence dies
wherever it was — and `stop` isn't atomic: between ACPI quiesce (VM → TERMINATED)
and the snapshot, the live disk is the **only** copy of the save. Re-running
`stop` resumes safely (it skips ACPI when already TERMINATED), but the operator
has to know that, and a stranded VM bills until they do.

Idea: have the CLI **enqueue a Job** via the existing `packages/jobs` publisher
(Pub/Sub | HTTP) instead of calling the provider inline — the same hand-off
`apps/interactions` already uses. The `apps/worker` consumes it and runs
`provider.stop` server-side, so:

- closing the terminal no longer strands the operation (it's already off-box),
- the lifecycle execution path is **consolidated** — worker is the one place that
  drives the provider, instead of CLI and worker each having their own call site,
- idempotency/retry (`allowAlreadyStopped`, redelivery) is handled once, where it
  already lives.

Open questions: CLI would lose the synchronous "✅ stopped" line (needs to poll
status or tail the job result); local-dev `JOB_TRANSPORT=http` path must stay
usable without the full control plane; do we keep an inline `--local` escape hatch
for when there's no worker deployed.
