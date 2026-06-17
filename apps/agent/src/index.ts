/**
 * Idle agent — runs ON the game VM (systemd timer or loop). It polls how busy
 * the server is and, when empty for long enough, asks the control plane to stop
 * it. The control plane (worker) does the snapshot + delete; the agent just
 * signals, so the VM's service account stays minimal.
 *
 * This is a skeleton: `countPlayers` is the per-game probe to fill in (Minecraft
 * Server List Ping, an RCON query, or a generic "any TCP connections on the game
 * port" check). Keeping it generic-first matches the any-game goal.
 *
 * SHORTCUTS.md (#6): signal-and-forget. Hardening (confirm snapshot landed before
 * the worker deletes) comes later.
 */
const SERVER_ID = process.env.ONEHOST_SERVER_ID ?? '';
const STOP_ENDPOINT = process.env.ONEHOST_STOP_ENDPOINT ?? '';
const IDLE_MINUTES = Number(process.env.ONEHOST_IDLE_MINUTES ?? 15);
const POLL_SECONDS = Number(process.env.ONEHOST_POLL_SECONDS ?? 60);

let emptyForMs = 0;

async function tick(): Promise<void> {
  const players = await countPlayers();
  if (players > 0) {
    emptyForMs = 0;
    return;
  }
  emptyForMs += POLL_SECONDS * 1000;
  if (emptyForMs >= IDLE_MINUTES * 60_000) {
    await requestStop();
  }
}

/** TODO: real probe. Returns active player count (0 = idle). */
async function countPlayers(): Promise<number> {
  return 0;
}

async function requestStop(): Promise<void> {
  console.log(`idle for ${IDLE_MINUTES}m — requesting stop of '${SERVER_ID}'`);
  await fetch(STOP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: SERVER_ID }),
  });
}

setInterval(() => {
  void tick();
}, POLL_SECONDS * 1000);

console.log(`onehost agent watching '${SERVER_ID}' (idle stop after ${IDLE_MINUTES}m)`);
