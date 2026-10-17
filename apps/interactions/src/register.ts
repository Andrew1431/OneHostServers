/**
 * Register OneHost's slash commands with Discord. Run once (and again whenever
 * the command set changes):
 *
 *   pnpm register
 *
 * Reads DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN / DISCORD_GUILD_IDS from the
 * repo-root .env (or the environment) — see loadDotEnv below — so nothing has to
 * be passed on the command line.
 *
 * DISCORD_GUILD_IDS (comma-separated; DISCORD_GUILD_ID still works) registers to
 * each listed guild — instant. Leave it empty to register globally: one set of
 * commands for every guild the app is installed in, but propagation takes up to
 * an hour. The bot token is needed ONLY here — the runtime endpoint and the
 * worker's follow-ups use the per-request interaction token instead, so no
 * long-lived secret sits in the request path.
 *
 * Who-can-run is Discord's own RBAC: commands register guild-only and visible to
 * everyone by default; narrow them per guild in Server Settings → Integrations →
 * OneHost (per-channel and per-role overrides). Set DISCORD_COMMANDS_LOCKED=1 to
 * register them hidden from everyone without the Administrator permission until a
 * guild grants them there. The endpoint's optional guild/channel allowlists
 * (authz.ts) back this up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

loadDotEnv(); // pull DISCORD_* from the repo-root .env so no shell sourcing is needed

const APPLICATION_ID = required('DISCORD_APPLICATION_ID');
const BOT_TOKEN = required('DISCORD_BOT_TOKEN');
const GUILD_IDS = [
  ...new Set(
    `${process.env.DISCORD_GUILD_IDS ?? ''},${process.env.DISCORD_GUILD_ID ?? ''}`
      .split(/[\s,]+/)
      .filter(Boolean),
  ),
];

/** Discord's InteractionContextType.GUILD / ApplicationIntegrationType.GUILD_INSTALL. */
const GUILD_ONLY = { contexts: [0], integration_types: [0] } as const;
/** Bitfield "0" = no one but Administrators until a guild grants it; null = everyone. */
const DEFAULT_PERMS = {
  default_member_permissions: process.env.DISCORD_COMMANDS_LOCKED === '1' ? '0' : null,
};

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
].map((c) => ({ ...c, ...GUILD_ONLY, ...DEFAULT_PERMS }));

const base = `https://discord.com/api/v10/applications/${APPLICATION_ID}`;
const targets = GUILD_IDS.length
  ? GUILD_IDS.map((g) => ({ label: `guild ${g}`, url: `${base}/guilds/${g}/commands` }))
  : [{ label: 'global (up to 1h to propagate)', url: `${base}/commands` }];

let failed = false;
for (const { label, url } of targets) {
  const res = await fetch(url, {
    method: 'PUT', // PUT = bulk overwrite; the registered set becomes exactly `commands`.
    headers: {
      authorization: `Bot ${BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    console.error(`✗ registration to ${label} failed: ${res.status}`);
    console.error(await res.text());
    failed = true;
    continue;
  }
  const registered = (await res.json()) as Array<{ name: string }>;
  console.log(`✅ registered ${registered.length} commands to ${label}:`);
  for (const c of registered) console.log(`   /${c.name}`);
}
if (failed) process.exit(1);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ missing ${name} (set it in the repo-root .env or the environment)`);
    process.exit(1);
  }
  return value;
}

/** Load KEY=VALUE pairs from the repo-root .env, without clobbering real env vars. */
function loadDotEnv(): void {
  let dir = process.cwd();
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) return; // not in the workspace; rely on the environment
    dir = parent;
  }
  const path = join(dir, '.env');
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}
