# State improvements: per-server lease + wired state machine

Design for making chat-invoked `start`/`stop` transactional. Today nothing
serializes lifecycle operations per server — the worker has no scaling limits,
Pub/Sub push delivers jobs concurrently (possibly to different Cloud Run
instances), and the provider is the only source of truth, so GCP's instance
status can't represent "a stop job is in flight but hasn't touched the API yet".

## Races this fixes

| Race | Failure today |
| --- | --- |
| start + start (same id) | Both read the latest snapshot and call `disks.insert` with the same disk name (`packages/gcp/src/provider.ts:242`). The loser's `deleteDiskQuietly` cleanup (`provider.ts:297`) can delete the disk the winner just created but hasn't attached yet — both fail, or one "succeeds" on a yanked boot disk. |
| stop + stop | Both `locate` the instance, both quiesce/snapshot. `allowAlreadyStopped` (`provider.ts:313`) only covers a second stop arriving *after* the instance is gone; mid-flight overlap errors or leaves a duplicate snapshot that confuses `pruneSnapshots`. |
| start + stop | Stop's `locate` catches an instance mid-provisioning and ACPI-stops it during first boot — snapshotting a half-initialized disk, which becomes the "latest" restore point. Silently corrupts the save chain. |
| Pub/Sub redelivery | The worker acks after doing the work (`apps/worker/src/index.ts`); a crash or a start past the 600s timeout redelivers the job and re-runs the whole VM op. No idempotency keys (SHORTCUTS #5). |

## What already exists

- `packages/core/src/state.ts` — the pure transition guard. `nextState(from, event)`
  throws `InvalidTransitionError` on illegal moves (`STOPPED --start--> STARTING`,
  `RUNNING --stop--> STOPPING`, etc.). Built for exactly this; wired to nothing.
- `packages/state/src/index.ts` — the `ServerRepository` persistence seam with an
  in-memory fake. The Firestore implementation was always the plan; this design
  is why it lands.

## Design

### 1. Firestore repository (`@onehost/state`)

Add `FirestoreServerRepository` implementing `ServerRepository`, plus a lease
surface. One document per server, collection `servers`, doc id = server id:

```ts
interface ServerDoc {
  state: ServerState;          // STOPPED | STARTING | RUNNING | STOPPING | ERROR
  lease?: {
    jobId: string;             // Pub/Sub messageId (or a UUID for CLI callers)
    kind: 'start' | 'stop';
    acquiredAt: Timestamp;
  };
  updatedAt: Timestamp;
}
```

Firestore in Native mode, default database — no schema, ~zero cost at this
scale, and transactions give the compare-and-swap. Terraform: enable
`firestore.googleapis.com`, create the database, grant the worker SA
`roles/datastore.user`.

### 2. Transactional claim in the worker

`handleJob` wraps lifecycle jobs (`start`, `stop`) in claim → work → release:

```
claim(id, kind, jobId):            // one Firestore transaction
  doc = read(servers/id)
  state = doc?.state ?? inferFromProvider()   // first-touch backfill, see §4
  if doc.lease is live (age < LEASE_TTL):
    if doc.lease.jobId == jobId: return ALREADY_MINE   // redelivery → resume/no-op
    return BUSY(doc.lease.kind)                        // friendly Discord reply
  next = nextState(state, kind)     // throws InvalidTransitionError
  write { state: next, lease: {jobId, kind, now} }
  return CLAIMED
```

- `CLAIMED` → run the provider op. On success, transaction: apply
  `nextState('started'|'stopped')`, clear the lease. On failure, transaction:
  `nextState('fail')` → `ERROR`, clear the lease, report to Discord.
- `BUSY` → reply "⏳ `mc-server` is already starting — hang on." No provider
  call, no GCP 409, ack the message.
- `InvalidTransitionError` → reply "already running" / "already stopped" /
  "in ERROR — reset it from the CLI". Ack.
- `ALREADY_MINE` → a redelivery of a job whose worker died mid-op. Check the
  provider (`status(id)`): if the target state was reached, finalize the doc and
  reply success; otherwise re-run the op (the provider's compensating cleanup
  makes a re-run from scratch safe once no other job is concurrent — which the
  lease now guarantees).

`LEASE_TTL`: 15 minutes — comfortably above the worst start (600s Cloud Run
timeout) and matches the interaction-token lifetime. A lease older than TTL is
stale (worker crashed *and* Pub/Sub gave up); the next claimant reconciles
against `provider.status()` before proceeding.

`jobId`: use the Pub/Sub `messageId` from the push envelope (stable across
redeliveries — this is what makes redelivery idempotent). `parsePushBody` in
`@onehost/jobs` grows a `messageId` field; the local `HttpPublisher` generates a
UUID to keep the envelope identical.

### 3. ERROR handling

`fail` parks the doc in `ERROR`, which refuses both `start` and `stop` — a
deliberate circuit breaker so a flapping server isn't hammered from chat. The
existing state machine's `reset` event clears it: add `pnpm cli reset <id>`
(verify with `provider.status()`, then transition `ERROR → STOPPED` / correct
state). Optionally let a stale-TTL claim auto-reset when the provider status is
unambiguous, so a transient failure doesn't require CLI intervention.

### 4. Backfill / drift

Existing servers have no doc. On first claim with no doc, seed from
`provider.status(id)` (RUNNING/STOPPED) inside the same transaction. The
provider stays the source of truth for *what exists*; Firestore is only the
serialization point for *in-flight intent*. If the two disagree outside a lease
(e.g. someone stopped a VM from the GCP console), the claim path trusts the
provider and repairs the doc.

### 5. CLI

The CLI drives the provider directly and can race the worker too. Same repo,
same claim: `apps/cli` acquires the lease (UUID jobId) around `start`/`stop`.
Requires ADC with Firestore access — already true for anyone running the CLI.
Degrade gracefully: if Firestore is unreachable/not provisioned, warn and
proceed unlocked (preserves the current no-control-plane, CLI-only setup).

### 6. Not changing

- `create`/`destroy` stay CLI-only and unleased for now (low collision risk;
  can adopt the same claim later).
- The provider (`packages/gcp`) is untouched — leasing is a control-plane
  concern and lives above the seam, so an AWS provider inherits it for free.
- `sweep`'s auto-stop goes through the same `stop` claim path, replacing its
  reliance on `allowAlreadyStopped` for manual-stop races.

## Companion change (do together)

Dead-letter policy on the `onehost-jobs-worker` subscription
(`max_delivery_attempts = 5`, DLQ topic) so a poison job stops redelivering
forever. Two lines of Terraform once leasing makes redelivery safe.

## Implementation order

1. `@onehost/state`: `FirestoreServerRepository` + `claim`/`release` (unit-test
   against the in-memory fake with injected clock).
2. `@onehost/jobs`: carry `messageId` through `parsePushBody` / `HttpPublisher`.
3. `apps/worker/handler.ts`: claim → work → release for start/stop; BUSY and
   InvalidTransition replies.
4. `infra/`: Firestore API + DB, worker SA `datastore.user`, DLQ.
5. `apps/cli`: shared claim + `reset` command.
