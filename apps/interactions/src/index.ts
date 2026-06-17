import { createServer, type IncomingMessage } from 'node:http';
import { verifyKey } from 'discord-interactions';

/**
 * Discord HTTP Interactions endpoint. Verifies Ed25519 signatures, answers the
 * PING handshake, and ACKs commands with a *deferred* response (type 5) within
 * Discord's 3-second window. The slow GCP work is handed to the worker.
 *
 * Runtime target: Cloud Run. Local dev: `pnpm --filter @onehost/interactions dev`.
 *
 * SHORTCUTS.md (#5): the job hand-off below is a TODO log line — wiring Pub/Sub
 * publish + AuthZ (Discord role check) is the next vertical slice.
 */
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';
const PORT = Number(process.env.PORT ?? 8080);

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const InteractionResponseType = {
  PONG: 1,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

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
    const command = interaction.data?.name;
    // TODO(SHORTCUTS #5): publish { command, options, interactionToken } to Pub/Sub.
    console.log(`received command '${command}' — would enqueue job here`);
    return json(res, {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  }

  res.writeHead(400).end();
});

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

function json(res: import('node:http').ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
}
