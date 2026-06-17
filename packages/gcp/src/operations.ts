import type {
  ZoneOperationsClient,
  GlobalOperationsClient,
} from '@google-cloud/compute';

/**
 * GCP Compute calls return a long-running Operation. These helpers poll it to
 * completion. This is the documented pattern for @google-cloud/compute v4.
 *
 * SHORTCUTS.md (#5): naive blocking poll, no backoff cap or timeout. Fine for a
 * CLI; the worker will want a bounded wait + resumable op handles later.
 */

// Mutation calls resolve to `[response]` where `response.latestResponse` is the
// Operation message. We only need name + status; `status` is a proto enum union
// (not plain string), so we keep the structural shape minimal and unknown-typed.
interface OpLike {
  name?: string | null | undefined;
  status?: unknown;
}
interface OpResponse {
  latestResponse: OpLike;
}

export async function waitZonal(
  client: ZoneOperationsClient,
  projectId: string,
  zone: string,
  response: OpResponse,
): Promise<void> {
  let operation: OpLike = response.latestResponse;
  while (operation.status !== 'DONE') {
    [operation] = await client.wait({
      operation: operation.name ?? '',
      project: projectId,
      zone,
    });
  }
}

export async function waitGlobal(
  client: GlobalOperationsClient,
  projectId: string,
  response: OpResponse,
): Promise<void> {
  let operation: OpLike = response.latestResponse;
  while (operation.status !== 'DONE') {
    [operation] = await client.wait({
      operation: operation.name ?? '',
      project: projectId,
    });
  }
}
