/**
 * Register OneHost's slash commands with Discord. Run once (and again whenever
 * the command set changes):
 *
 *   DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=… \
 *     pnpm --filter @onehost/interactions register
 *
 * Guild-scoped commands register instantly (global ones take up to an hour to
 * propagate), so we target a guild. The bot token is needed ONLY here — the
 * runtime interactions endpoint and the worker's follow-ups use the per-request
 * interaction token instead, so no long-lived secret sits in the request path.
 *
 * Restricting the command to one channel is done in Discord (Server Settings →
 * Integrations → this app → Channels), reinforced by the DISCORD_CHANNEL_ID
 * guard in the endpoint. We register with no default member permissions so the
 * channel/role config is the single source of who-can-run.
 */
export {}; // make this a module so top-level await is allowed

const APPLICATION_ID = required('DISCORD_APPLICATION_ID');
const BOT_TOKEN = required('DISCORD_BOT_TOKEN');
const GUILD_ID = required('DISCORD_GUILD_ID');

const CommandOptionType = { STRING: 3 } as const;

const commands = [
  {
    name: 'list',
    description: 'List all servers and their status (running, stopped, address).',
  },
  {
    name: 'start',
    description: 'Start a server — restores its snapshot and boots it.',
    options: [
      {
        type: CommandOptionType.STRING,
        name: 'id',
        description: 'The server id (as shown by /list).',
        required: true,
      },
    ],
  },
  {
    name: 'stop',
    description: 'Stop a server — snapshots its disk and deletes the VM (~$0 idle).',
    options: [
      {
        type: CommandOptionType.STRING,
        name: 'id',
        description: 'The server id (as shown by /list).',
        required: true,
      },
    ],
  },
];

const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;
const res = await fetch(url, {
  method: 'PUT', // PUT = bulk overwrite; the registered set becomes exactly `commands`.
  headers: {
    authorization: `Bot ${BOT_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`✗ registration failed: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const registered = (await res.json()) as Array<{ name: string }>;
console.log(`✅ registered ${registered.length} commands to guild ${GUILD_ID}:`);
for (const c of registered) console.log(`   /${c.name}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ missing ${name}`);
    process.exit(1);
  }
  return value;
}
