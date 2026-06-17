import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ServerProvider } from '@onehost/provider-api';
import type { ServerSummary } from '@onehost/core';
import { GcpServerProvider, configFromEnv } from '@onehost/gcp';
import { parsePushBody, type Job } from '@onehost/jobs';

/**
 * The job worker. Pub/Sub pushes a {@link Job} here (or the local HttpPublisher
 * posts the same envelope); we drive the provider, then edit the originating
 * Discord message in place via its interaction token. On Cloud Run we do the work
 * *before* responding 2xx — that's what acks the message — so a push must finish
 * within the Cloud Run request timeout (set it ≥ a slow start, ~600s).
 *
 * Source of truth is the cloud (the provider), not a database: `list` reads live
 * instances + snapshots directly, and start/stop just act and report. The
 * Firestore `@onehost/state` repo + the `nextState` guard get wired in when
 * persistence lands; until then there's nothing durable to desync.
 *
 * Runtime target: Cloud Run (private; invoked only by the Pub/Sub push SA).
 */
const PORT = Number(process.env.PORT ?? 8080);
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID ?? '';
const DISCORD_API = 'https://discord.com/api/v10';
/** Optional shared secret on the push URL (?token=). Empty = rely on Cloud Run IAM. */
const PUSH_TOKEN = process.env.PUBSUB_PUSH_TOKEN ?? '';

export interface WorkerDeps {
  provider: ServerProvider;
  /** Edits the original interaction reply. Defaults to Discord's REST API. */
  followUp: (interactionToken: string, message: string) => Promise<void>;
}

export async function handleJob(deps: WorkerDeps, job: Job): Promise<void> {
  try {
    switch (job.kind) {
      case 'start': {
        const running = await deps.provider.start(job.id);
        await deps.followUp(
          job.interactionToken,
          `🟢 **${job.id}** is up at \`${running.address}\``,
        );
        break;
      }
      case 'stop': {
        await deps.provider.stop(job.id);
        await deps.followUp(job.interactionToken, `⚪ **${job.id}** stopped and snapshotted.`);
        break;
      }
      case 'list': {
        const servers = await deps.provider.list();
        await deps.followUp(job.interactionToken, formatServers(servers));
        break;
      }
    }
  } catch (err) {
    const target = job.kind === 'list' ? 'servers' : `**${job.id}**`;
    await deps.followUp(
      job.interactionToken,
      `🔴 ${target} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

/** Render a server list as a Discord code block — `/list` doubles as status. */
function formatServers(servers: ServerSummary[]): string {
  if (servers.length === 0) return 'No servers yet.';
  const icon: Record<string, string> = {
    RUNNING: '🟢',
    STARTING: '🟡',
    STOPPING: '🟡',
    STOPPED: '⚪',
    ERROR: '🔴',
  };
  const lines = servers.map((s) => {
    const where = s.address ?? (s.state === 'RUNNING' ? '(no address)' : '—');
    return `${icon[s.state] ?? '•'} ${s.id} · ${s.state} · ${where}`;
  });
  return lines.join('\n');
}

/**
 * Edit the original interaction reply (the "⏳ working" message). No bot token
 * needed — the interaction token authorizes it, valid for 15 minutes.
 */
async function editOriginal(interactionToken: string, content: string): Promise<void> {
  if (!APPLICATION_ID) {
    console.error('DISCORD_APPLICATION_ID unset — cannot edit interaction reply');
    return;
  }
  const url = `${DISCORD_API}/webhooks/${APPLICATION_ID}/${interactionToken}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error(`discord edit failed: ${res.status} ${await res.text()}`);
  }
}

// --- HTTP transport (Pub/Sub push) -----------------------------------------

const deps: WorkerDeps = {
  provider: new GcpServerProvider(configFromEnv()),
  followUp: editOriginal,
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  if (PUSH_TOKEN && tokenOf(req) !== PUSH_TOKEN) {
    res.writeHead(401).end('bad push token');
    return;
  }

  let job: Job;
  try {
    job = parsePushBody((await readBody(req)).toString('utf8'));
  } catch (err) {
    console.error('bad push body:', err);
    res.writeHead(400).end('bad request');
    return;
  }

  // Process before acking. handleJob reports its own errors to Discord, so we
  // ack (204) either way to avoid a redelivery re-running the VM op (no
  // idempotency keys yet — SHORTCUTS #5).
  await handleJob(deps, job);
  res.writeHead(204).end();
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`worker listening on :${PORT}`);
  });
}

/** Push subscriptions can carry a shared secret as a `?token=` query param. */
function tokenOf(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') ?? undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
