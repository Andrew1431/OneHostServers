/**
 * Defense-in-depth allowlists, checked after the signature. The primary gate is
 * Discord's own command permissions (Server Settings → Integrations → OneHost:
 * per-channel + per-role overrides). These only matter if the app gets installed
 * somewhere it shouldn't be, or a guild admin opens it wider than intended.
 *
 * Empty list = no guard on that axis.
 */
export interface AccessPolicy {
  guilds: ReadonlySet<string>;
  channels: ReadonlySet<string>;
}

export type AccessDecision = { ok: true } | { ok: false; reason: string };

/** Parse a comma/whitespace-separated id list from env. */
export function idList(...values: Array<string | undefined>): Set<string> {
  return new Set(
    values
      .flatMap((v) => (v ?? '').split(/[\s,]+/))
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): AccessPolicy {
  return {
    guilds: idList(env.DISCORD_ALLOWED_GUILDS),
    // DISCORD_CHANNEL_ID is the old single-channel name; still honored.
    channels: idList(env.DISCORD_ALLOWED_CHANNELS, env.DISCORD_CHANNEL_ID),
  };
}

export function checkAccess(
  interaction: { guild_id?: string; channel_id?: string },
  policy: AccessPolicy,
): AccessDecision {
  // Commands are registered guild-only (contexts: [0]); a DM has no guild_id.
  if (!interaction.guild_id) {
    return { ok: false, reason: 'OneHost commands only work inside a server.' };
  }
  if (policy.guilds.size > 0 && !policy.guilds.has(interaction.guild_id)) {
    return { ok: false, reason: 'OneHost is not enabled for this server.' };
  }
  if (
    policy.channels.size > 0 &&
    !(interaction.channel_id && policy.channels.has(interaction.channel_id))
  ) {
    return { ok: false, reason: 'OneHost is not enabled in this channel.' };
  }
  return { ok: true };
}
