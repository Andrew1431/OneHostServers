import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GcpServerProvider, configFromEnv } from '@onehost/gcp';
import { dnsProviderFromEnv } from '@onehost/dns';
import { parsePushBody, type Job } from '@onehost/jobs';
import { handleJob, makeNotify, type DiscordMessage, type WorkerDeps } from './handler.ts';

export { handleJob, makeNotify } from './handler.ts';
export type { WorkerDeps, DiscordMessage, Embed } from './handler.ts';

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
 * The pure job→reply logic lives in `handler.ts` (testable with no config/HTTP
 * side effects); this module wires the real provider + notifier and the HTTP
 * transport.
 *
 * Runtime target: Cloud Run (private; invoked only by the Pub/Sub push SA).
 */
const PORT = Number(process.env.PORT ?? 8080);
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID ?? '';
const DISCORD_API = 'https://discord.com/api/v10';
/** Optional shared secret on the push URL (?token=). Empty = rely on Cloud Run IAM. */
const PUSH_TOKEN = process.env.PUBSUB_PUSH_TOKEN ?? '';
/**
 * Channel webhook for jobs with no interaction to edit (idle self-teardown, and
 * the reconcile sweep / long-running nag). Empty = those jobs run silently.
 */
const CHANNEL_WEBHOOK_URL = process.env.DISCORD_CHANNEL_WEBHOOK_URL ?? '';

/**
 * Edit the original interaction reply (the "⏳ working" message). No bot token
 * needed — the interaction token authorizes it, valid for 15 minutes.
 */
async function editOriginal(interactionToken: string, message: DiscordMessage): Promise<void> {
  if (!APPLICATION_ID) {
    console.error('DISCORD_APPLICATION_ID unset — cannot edit interaction reply');
    return;
  }
  const url = `${DISCORD_API}/webhooks/${APPLICATION_ID}/${interactionToken}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    console.error(`discord edit failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Post to the channel webhook for jobs with no interaction to edit. A no-op (with
 * a log line) when unconfigured, so an idle teardown still completes silently
 * rather than failing.
 */
async function postWebhook(message: DiscordMessage): Promise<void> {
  if (!CHANNEL_WEBHOOK_URL) {
    console.log('DISCORD_CHANNEL_WEBHOOK_URL unset — tokenless job ran without notifying');
    return;
  }
  const res = await fetch(CHANNEL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    console.error(`discord webhook post failed: ${res.status} ${await res.text()}`);
  }
}

// --- HTTP transport (Pub/Sub push) -----------------------------------------

// undefined when no DUCKDNS_TOKEN is set — DNS is opt-in, jobs run as before.
const dns = await dnsProviderFromEnv();
const deps: WorkerDeps = {
  provider: new GcpServerProvider(configFromEnv()),
  notify: makeNotify(editOriginal, postWebhook),
  ...(dns ? { dns } : {}),
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
