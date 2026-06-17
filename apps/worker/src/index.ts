import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ServerId, ServerState, ServerSummary } from '@onehost/core';
import type { ServerProvider } from '@onehost/provider-api';
import { STATE_ICON, describeMachine, viewServer } from '@onehost/core';
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

/** A subset of the Discord embed object — enough to render rich status replies. */
interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}
interface DiscordMessage {
  content?: string;
  embeds?: Embed[];
}

/** Discord embed side-bar colors, by server state. */
const STATE_COLOR: Record<ServerState, number> = {
  RUNNING: 0x57f287, // green
  STARTING: 0xfee75c, // yellow
  STOPPING: 0xfee75c,
  STOPPED: 0x99aab5, // grey
  ERROR: 0xed4245, // red
};

export interface WorkerDeps {
  provider: ServerProvider;
  /** Edits the original interaction reply. Defaults to Discord's REST API. */
  followUp: (interactionToken: string, message: DiscordMessage) => Promise<void>;
}

export async function handleJob(deps: WorkerDeps, job: Job): Promise<void> {
  try {
    switch (job.kind) {
      case 'start': {
        await deps.provider.start(job.id);
        await deps.followUp(job.interactionToken, { embeds: [await startedEmbed(deps, job.id)] });
        break;
      }
      case 'stop': {
        await deps.provider.stop(job.id);
        await deps.followUp(job.interactionToken, {
          embeds: [
            {
              title: `${STATE_ICON.STOPPED} ${job.id} stopped`,
              description: 'Disk snapshotted, instance + disk deleted — idle cost is now ~$0.',
              color: STATE_COLOR.STOPPED,
            },
          ],
        });
        break;
      }
      case 'list': {
        const servers = await deps.provider.list();
        await deps.followUp(job.interactionToken, { embeds: [listEmbed(servers)] });
        break;
      }
    }
  } catch (err) {
    const target = job.kind === 'list' ? 'servers' : job.id;
    await deps.followUp(job.interactionToken, {
      embeds: [
        {
          title: `${STATE_ICON.ERROR} ${target} failed`,
          description: err instanceof Error ? err.message : 'unknown error',
          color: STATE_COLOR.ERROR,
        },
      ],
    });
  }
}

/**
 * Build the "started" embed. `start` returns only id + address, so we read the
 * live summary back to surface machine/zone detail (the start already took
 * minutes — one extra list call is noise). Falls back to address-only if the row
 * isn't found yet.
 */
async function startedEmbed(deps: WorkerDeps, id: ServerId): Promise<Embed> {
  const summary = (await deps.provider.list()).find((s) => s.id === id);
  if (!summary) {
    return {
      title: `${STATE_ICON.RUNNING} ${id} is up`,
      color: STATE_COLOR.RUNNING,
    };
  }
  const v = viewServer(summary);
  return {
    title: `${v.icon} ${id} is up`,
    color: STATE_COLOR[summary.state],
    fields: [
      { name: 'Address', value: `\`${v.address}\``, inline: true },
      { name: 'Zone', value: v.zone, inline: true },
      { name: 'Machine', value: v.machine },
      { name: 'Disk', value: v.disk, inline: true },
    ],
  };
}

/** Render the whole fleet as one embed, a field per server — `/list` doubles as status. */
function listEmbed(servers: ServerSummary[]): Embed {
  if (servers.length === 0) {
    return { title: 'No servers yet', description: 'Create one with the CLI first.', color: STATE_COLOR.STOPPED };
  }
  return {
    title: 'Servers',
    color: STATE_COLOR.RUNNING,
    fields: servers.map((s) => {
      const v = viewServer(s);
      const details = [`${describeMachine(s.machineType)} · ${v.disk}`];
      if (s.zone) details.push(`zone ${s.zone}`);
      details.push(v.address);
      return { name: `${v.icon} ${v.id} · ${v.state}`, value: details.join('\n') };
    }),
  };
}

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
