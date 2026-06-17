import type { ServerProvider } from '@onehost/provider-api';
import type { ServerRepository } from '@onehost/state';
import { nextState } from '@onehost/core';

/**
 * Pub/Sub-triggered worker. Consumes a job, drives the provider, updates state,
 * and posts the Discord follow-up. This file is the *handler shape* — the
 * Pub/Sub/Cloud Run transport wiring is the next slice.
 *
 * Deliberately pure-ish: the handler takes its dependencies so it unit-tests
 * against the in-memory repo + a fake provider with no cloud.
 */
export type Job =
  | { kind: 'start'; id: string; interactionToken: string }
  | { kind: 'stop'; id: string; interactionToken: string };

export interface WorkerDeps {
  provider: ServerProvider;
  repo: ServerRepository;
  followUp: (interactionToken: string, message: string) => Promise<void>;
}

export async function handleJob(deps: WorkerDeps, job: Job): Promise<void> {
  const record = await deps.repo.get(job.id);
  if (record === undefined) {
    await deps.followUp(job.interactionToken, `Unknown server '${job.id}'.`);
    return;
  }

  try {
    if (job.kind === 'start') {
      await deps.repo.put({ ...record, state: nextState(record.state, 'start') });
      const running = await deps.provider.start(job.id);
      await deps.repo.put({
        ...record,
        state: nextState('STARTING', 'started'),
        address: running.address,
        updatedAt: new Date().toISOString(),
      });
      await deps.followUp(job.interactionToken, `🟢 **${job.id}** is up at \`${running.address}\``);
    } else {
      await deps.repo.put({ ...record, state: nextState(record.state, 'stop') });
      await deps.provider.stop(job.id);
      await deps.repo.put({
        ...record,
        state: nextState('STOPPING', 'stopped'),
        updatedAt: new Date().toISOString(),
        // address intentionally cleared on stop
      });
      await deps.followUp(job.interactionToken, `⚪ **${job.id}** stopped and snapshotted.`);
    }
  } catch (err) {
    await deps.repo.put({ ...record, state: 'ERROR', updatedAt: new Date().toISOString() });
    await deps.followUp(
      job.interactionToken,
      `🔴 **${job.id}** failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
