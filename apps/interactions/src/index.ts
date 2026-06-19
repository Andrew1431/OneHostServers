import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyKey } from 'discord-interactions';
import { publisherFromEnv, type Job } from '@onehost/jobs';

/**
 * Discord HTTP Interactions endpoint. Verifies Ed25519 signatures, answers the
 * PING handshake, and — within Discord's 3-second window — ACKs a command with a
 * "⏳ working" message, then hands the slow GCP work to the worker via a Job
 * (Pub/Sub in prod, direct HTTP locally). The worker edits this same message in
 * place when the VM is up/down (see apps/worker).
 *
 * Commands: /list (also serves as status), /start <id>, /stop <id>. Provisioning
 * (create/destroy) is intentionally CLI-only by design.
 *
 * AuthZ (issue #5): delegated to Discord. Register the commands to a single
 * channel and use Discord's channel/role permissions to decide who may run them.
 * As defense-in-depth we also reject any interaction whose channel_id isn't the
 * configured DISCORD_CHANNEL_ID (when set).
 *
 * Runtime target: Cloud Run. Local dev: `pnpm --filter @onehost/interactions dev`.
 */
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';
const PORT = Number(process.env.PORT ?? 8080);
/** When set, commands are only accepted from this channel. Empty = no guard. */
const ALLOWED_CHANNEL = process.env.DISCORD_CHANNEL_ID ?? '';

const publisher = publisherFromEnv();

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;
/** MessageFlags.EPHEMERAL — only the invoking user sees the reply. */
const EPHEMERAL = 1 << 6;

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  const signature = header(req, 'x-signature-ed25519');
  const timestamp = header(req, 'x-signature-timestamp');
  const rawBody = await readBody(req);

  const valid =
    signature !== undefined &&
    timestamp !== undefined &&
    (await verifyKey(rawBody, signature, timestamp, PUBLIC_KEY));
  if (!valid) {
    res.writeHead(401).end('invalid request signature');
    return;
  }

  const interaction = JSON.parse(rawBody.toString('utf8'));

  if (interaction.type === InteractionType.PING) {
    return json(res, { type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return handleCommand(res, interaction);
  }

  res.writeHead(400).end();
});

async function handleCommand(res: ServerResponse, interaction: any): Promise<void> {
  if (ALLOWED_CHANNEL && interaction.channel_id !== ALLOWED_CHANNEL) {
    return reply(res, 'This command can only be used in the OneHost channel.', EPHEMERAL);
  }

  const name: string = interaction.data?.name;
  const token: string = interaction.token;

  let job: Job;
  let working: string;
  switch (name) {
    case 'list':
      job = { kind: 'list', interactionToken: token };
      working = '⏳ Fetching servers…';
      break;
    case 'start':
    case 'stop': {
      const id = stringOption(interaction, 'id');
      if (!id) return reply(res, `\`/${name}\` needs a server id.`, EPHEMERAL);
      job = { kind: name, id, interactionToken: token };
      working = name === 'start' ? `⏳ Starting **${id}**…` : `⏳ Stopping **${id}**…`;
      break;
    }
    default:
      return reply(res, `Unknown command: \`/${name}\``, EPHEMERAL);
  }

  try {
    // Must complete before we ACK, or the job is lost. Publish is fast (~tens of ms).
    await publisher.publish(job);
  } catch (err) {
    console.error('failed to enqueue job:', err);
    return reply(res, '🔴 Could not queue that — try again in a moment.', EPHEMERAL);
  }

  // Public "working" message; the worker edits it to the result via the token.
  return reply(res, working);
}

/** Extract a string command option by name (Discord nests them under data.options). */
function stringOption(interaction: any, optionName: string): string | undefined {
  const opt = interaction.data?.options?.find((o: any) => o.name === optionName);
  const value = opt?.value;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function reply(res: ServerResponse, content: string, flags = 0): void {
  json(res, {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: flags ? { content, flags } : { content },
  });
}

server.listen(PORT, () => {
  console.log(`interactions endpoint listening on :${PORT}`);
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
}
