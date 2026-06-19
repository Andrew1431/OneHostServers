# OneHost testing plan

Goal: make AI-driven code changes safe to ship without manual end-to-end QA. We
test the **infrastructure decision logic and the interactive surfaces** — the
things that break silently and can't be eyeballed — and leave the on-VM contract
(`MACHINE_AGENT.md`) and one rarely-run live smoke as the only real-GCP paths.

The architecture is already most of the way there: `ServerProvider`
(`packages/provider-api`) is a clean seam, `handleJob(deps, job)`
(`apps/worker/src/index.ts`) takes its provider injected, and the parsing/pricing/
state logic is genuinely pure. The one thing missing is that the GCP clients are
hardcoded as field initializers in `packages/gcp/src/provider.ts:59-65`, so the
resiliency logic can only be exercised against real GCP today. Fixing that is the
single refactor worth doing.

## What "resiliency" means here

The behaviors that cause real incidents and can't be caught by reading a diff:

- **Zone fallback** (`provider.ts:461` `withZoneFallback`) — capacity error → next
  zone; any non-capacity error propagates immediately.
- **Orphan-disk cleanup on failed start** (`provider.ts:225-231`) — if instance
  insert fails after disk insert, the disk must be deleted or it bills forever.
- **Idempotent stop** (`allowAlreadyStopped`, `provider.ts:242-247`) and **ACPI
  skip when not RUNNING** (`provider.ts:265`).
- **Sizing-label carry-forward** across stop→snapshot→start (`provider.ts:253-257`,
  `166-169`).
- **Reconcile thresholds** (`provider.ts:406-450`) — disabled at `<=0`, auto-stop
  only when `>= maxUptime`, NAGGED dedup, uptime from
  `lastStartTimestamp ?? creationTimestamp`.
- **Snapshot prune** keep-count + newest-first (`provider.ts:659`), **latest
  snapshot selection** (`provider.ts:680`), **list merge** of live + snapshot-only
  with newest labels winning (`provider.ts:356`).
- **Error classification** — `isNotFound` (gRPC code 5, `provider.ts:722`),
  `isCapacityError` (regex, `provider.ts:731`).

## Tooling

- **Vitest** (ESM + `tsx` already in place → no build step). Node environment.
- Root `vitest.config.ts` with project globs; each package/app gets
  `"test": "vitest run"` so `turbo run test` fans out.
- No new runtime deps in shipped packages — test-only deps stay in `devDependencies`.

---

## Work packages

Each WP lists the files it **owns** (creates/edits). Ownership boundaries are
drawn so packages that run in parallel never touch the same file. See
"Parallelization" at the bottom before spawning anything.

### WP0 — Test harness (FOUNDATION, must land first)

Owns:
- `vitest.config.ts` (root, new)
- `package.json` (root — add `vitest` devDep; `test` script already exists)
- `turbo.json` (ensure a `test` task with no build dependency)
- A `"test": "vitest run"` script in **every** `packages/*/package.json` and
  `apps/*/package.json`, plus `vitest` as a devDep where missing.
- One trivial smoke test (e.g. `packages/core`) to prove the runner works.

Blocks: everything. Nothing else can run until this is merged.

### WP1 — Pure-logic unit tests (no behavioral refactor)

Owns:
- `packages/core/src/state.test.ts` — full transition matrix; every illegal move
  throws `InvalidTransitionError`; `canTransition` agrees with `nextState`.
- `packages/gcp/src/naming.test.ts` — `sanitizeName` (leading digit → `s-`,
  63/50-char clamp, hyphen collapse, trim), `snapshotName` suffix, `serverTag` /
  `firewallRuleName` length, `machineTypeName` (explicit type wins vs custom-e2).
- `packages/gcp/src/pricing.test.ts` — predefined vs custom rates, unknown family
  → `undefined`, `estimate` partial-knowledge (`totalHr` undefined only when both
  unknown), `regionMatches`, `fmtHr`.
- `packages/jobs/src/jobs.test.ts` — `parsePushBody` happy path (base64 → Job),
  rejects non-string `message.data`, rejects non-JSON.
- `apps/cli/src/parse.ts` (**new** — extracted) + `apps/cli/src/parse.test.ts`.

One small refactor (mechanical, no logic change): move the pure arg parsers out of
`apps/cli/src/index.ts:149-250` (`parseFlags`, `parsePorts`, `parsePortFlag`,
`parseStartOpts`, `parseSweepOpts`, `buildSpec`) into `apps/cli/src/parse.ts` and
re-import them in `index.ts`. They currently call `fail()` → `process.exit`, which
makes them untestable in-process; have them throw a typed error instead and let
`index.ts` catch→`fail`. Tests then cover: port ranges/lists, reversed range,
out-of-range, bad protocol, unknown flag, start-opts only-includes-passed,
sweep-opts env fallback + NaN guard.

> Coordinates with WP3 on `packages/gcp/package.json` (both add a test script).
> WP0 already adds that script — so WP1 and WP3 only add `.test.ts` files in gcp,
> no shared edits. Safe.

### WP2 — In-memory provider + worker control-plane tests

Owns:
- `packages/testing/` (**new** package, `@onehost/testing`) exporting
  `InMemoryProvider implements ServerProvider`, backed by the real `nextState`
  guard so it enforces the true lifecycle (e.g. `start` only from STOPPED). It
  records calls (incl. `StopOptions`/`StartOptions`) for assertions and can be
  scripted to throw.
- `apps/worker/src/handleJob.test.ts` — drive every `Job` kind against the fake
  with a spy `notify`. Assert:
  - `start` → started embed; `stop` passes `allowAlreadyStopped: true`
    (`worker/src/index.ts:82`).
  - `sweep` stays **silent** on an empty report, posts only when warned/stopped
    non-empty (`worker/src/index.ts:106`).
  - provider throw → **error embed via notify, not a rethrow**
    (`worker/src/index.ts:112`).
  - tokenless vs token-bearing routing (`notify` default, `worker/src/index.ts:178`).

This is the highest-leverage artifact: the fake powers worker tests now and the
interactive-CLI tests in WP4. It is the direct answer to "testing e2e flows is
strenuous" — it exercises enqueue → work → reply deterministically, no GCP.

> `handleJob` is already exported and takes `deps` — no worker refactor needed.

### WP3 — Provider injectability + GCP resiliency tests

Owns:
- `packages/gcp/src/provider.ts` (the one real refactor: make clients injectable).
- `packages/gcp/src/provider.test.ts` (new).
- A fake-GCP recording double (under `packages/gcp/src/__fixtures__/` or
  `packages/testing` — see note) returning canned `aggregatedListAsync` /
  `listAsync` pages and scripted capacity / not-found errors.

Refactor: replace the seven field initializers (`provider.ts:59-65`) with
constructor-injected clients carrying a default (e.g. an optional
`clients?: GcpClients` param that defaults to the real ones). No call-site changes
elsewhere — `new GcpServerProvider(cfg)` still works.

Then assert the resiliency list above: zone fallback (capacity → next, non-capacity
→ throw), failed-start disk cleanup, idempotent + ACPI-skip stop, label
carry-forward, reconcile thresholds/dedup, prune keep-count, latest-snapshot pick,
list merge.

> Touches `provider.ts` heavily. **No other WP edits `provider.ts`.** WP1 adds
> only `naming.test.ts`/`pricing.test.ts` in gcp. No collision.

### WP4 — Interactive CLI tests (DEPENDS ON WP2)

Owns:
- `apps/cli/src/interactive.test.ts`.

Approach: `vi.mock('@clack/prompts')` with a scripted answer queue + stub the
catalog (`GcpCatalog.listMachineTypes`/`listDiskTypes`). Run `createInteractively`
/ `startInteractively` against the WP2 `InMemoryProvider`. Assert the **`ServerSpec`
that reaches `provider.create`** (`interactive.ts:304`) is correct for predefined
and custom machine paths, and that cancelling at each step returns **without**
creating/starting. Don't snapshot clack rendering — test the decisions, not the UI.

Also covers the already-pure validators `validatePortsInput` / `parsePortsInput`
(`interactive.ts:204,221`) directly.

### WP5 — (Optional) gated live smoke

Owns:
- `apps/cli/src/e2e.smoke.test.ts` — skipped unless `GCP_PROJECT_ID` is set.
  create `e2-small` → stop → start → destroy; assert snapshot appears and disk is
  gone. The only true-GCP path; run before releases, not in CI by default.

---

## Parallelization — do they collide?

**Not fully independent.** The dependency graph:

```
WP0 (harness) ──┬─▶ WP1 (pure logic)        ┐
                ├─▶ WP2 (fake + worker) ─▶ WP4 (interactive CLI)
                └─▶ WP3 (provider refactor + gcp tests)
WP5 optional, independent, after WP0
```

- **WP0 must land first and alone.** It edits shared root config + every
  `package.json`. Running it concurrently with anything guarantees merge conflicts.
- **After WP0, WP1 / WP2 / WP3 run in parallel safely** — ownership is drawn so no
  two touch the same file. The only shared package is `packages/gcp`, where WP1
  adds `naming.test.ts`/`pricing.test.ts` and WP3 edits `provider.ts` +
  `provider.test.ts` — disjoint files, and WP0 already added gcp's test script.
- **WP4 depends on WP2's `InMemoryProvider`** — start it only after WP2 lands (or
  let WP2's agent continue into WP4).
- **The fake-GCP double (WP3) vs InMemoryProvider (WP2) are different things** —
  WP3's double mocks the GCP *client* layer to test the real provider; WP2's fake
  is an alternate *provider* impl. Keep them separate so the two agents don't
  contend over `packages/testing`. (If both want to live in `packages/testing`,
  WP3's lower-level GCP fixture should instead live under
  `packages/gcp/src/__fixtures__/` to keep ownership clean.)

**Recommended execution:** land WP0 yourself, then spawn WP1 + WP2 + WP3 in
parallel (worktree isolation), then WP4 after WP2. WP5 anytime after WP0.

## Definition of done

- `pnpm test` (→ `turbo run test`) green across all packages.
- Every resiliency behavior in the list above has a failing-without-the-code test.
- The full create flow (interactive) and every Discord job kind run in tests with
  zero network/GCP access.
- Live smoke documented as opt-in; not required for CI.
