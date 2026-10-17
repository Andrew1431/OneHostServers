import { describe, expect, it } from 'vitest';
import { checkAccess, idList, policyFromEnv } from './authz.ts';

const open = { guilds: new Set<string>(), channels: new Set<string>() };

describe('checkAccess', () => {
  it('rejects DMs (no guild)', () => {
    expect(checkAccess({ channel_id: 'c1' }, open).ok).toBe(false);
  });

  it('allows any guild/channel when no allowlist is set', () => {
    expect(checkAccess({ guild_id: 'g1', channel_id: 'c1' }, open).ok).toBe(true);
  });

  it('enforces the guild allowlist', () => {
    const p = { guilds: idList('g1,g2'), channels: new Set<string>() };
    expect(checkAccess({ guild_id: 'g2', channel_id: 'x' }, p).ok).toBe(true);
    expect(checkAccess({ guild_id: 'g3', channel_id: 'x' }, p).ok).toBe(false);
  });

  it('enforces the channel allowlist across guilds', () => {
    const p = { guilds: new Set<string>(), channels: idList('c1 c2') };
    expect(checkAccess({ guild_id: 'g1', channel_id: 'c1' }, p).ok).toBe(true);
    expect(checkAccess({ guild_id: 'g9', channel_id: 'c2' }, p).ok).toBe(true);
    expect(checkAccess({ guild_id: 'g1', channel_id: 'c3' }, p).ok).toBe(false);
  });
});

describe('policyFromEnv', () => {
  it('merges the legacy DISCORD_CHANNEL_ID into the channel list', () => {
    const p = policyFromEnv({ DISCORD_ALLOWED_CHANNELS: 'a, b', DISCORD_CHANNEL_ID: 'c' });
    expect([...p.channels].sort()).toEqual(['a', 'b', 'c']);
    expect(p.guilds.size).toBe(0);
  });
});
