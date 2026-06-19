import type {
  ZoneOperationsClient,
  GlobalOperationsClient,
} from '@google-cloud/compute';

/**
 * GCP Compute calls return a long-running Operation. These helpers poll it to
 * completion AND surface failures: a finished operation can still carry an
 * `error`, which we throw so callers see the real reason instead of a confusing
 * downstream "not found".
 *
 * Issue #17: naive blocking poll, no backoff cap or timeout. Fine for a
 * CLI; the worker will want a bounded wait + resumable op handles later.
 */

// Mutation calls resolve to `[response]` where `response.latestResponse` is the
// Operation message. We only need name/status/error; `status` is a proto enum
// union (not plain string), so we keep the shape minimal and unknown-typed.
// `error` is typed `unknown` here: the proto's IOperation.error type doesn't
// expose the `.errors[]` array that Compute actually populates at runtime, so we
// narrow structurally in throwIfFailed instead of fighting the generated types.
interface OpLike {
  name?: string | null | undefined;
  status?: unknown;
  error?: unknown;
}
interface OpResponse {
  latestResponse: OpLike;
}

interface OpErrorItem {
  code?: string | null;
  message?: string | null;
}

function throwIfFailed(operation: OpLike): void {
  const err = operation.error;
  const errors =
    typeof err === 'object' && err !== null && 'errors' in err
      ? ((err as { errors?: OpErrorItem[] | null }).errors ?? [])
      : [];
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.code ?? 'ERROR'}: ${e.message ?? ''}`).join('; ');
    throw new Error(`GCP operation failed — ${detail}`);
  }
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
  throwIfFailed(operation);
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
  throwIfFailed(operation);
}
