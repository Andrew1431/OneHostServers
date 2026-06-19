import type { ServerId, ServerState, ServerSummary } from '@onehost/core';
import type { ServerProvider, ReconcileReport } from '@onehost/provider-api';
import { STATE_ICON, describeMachine, viewServer } from '@onehost/core';
import type { Job } from '@onehost/jobs';

/**
 * Pure control-plane logic for the worker: turn a {@link Job} into provider calls
 * and a Discord reply. Kept free of config + HTTP side effects (those live in
 * `index.ts`) so it can be unit-tested by importing this module directly — no
 * `GCP_PROJECT_ID`, no listening socket. `index.ts` wires the real provider +
 * notifier and re-exports the public surface.
 */

/** A subset of the Discord embed object — enough to render rich status replies. */
export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}
export interface DiscordMessage {
  content?: string;
  embeds?: Embed[];
}

/** Discord embed side-bar colors, by server state. */
export const STATE_COLOR: Record<ServerState, number> = {
  RUNNING: 0x57f287, // green
  STARTING: 0xfee75c, // yellow
  STOPPING: 0xfee75c,
  STOPPED: 0x99aab5, // grey
  ERROR: 0xed4245, // red
};

export interface WorkerDeps {
  provider: ServerProvider;
  /**
   * Reports a job's result. Routes to the originating Discord interaction reply
   * when the job carries a token, else to the channel webhook (idle/sweep/nag
   * jobs have none). The default lives in `index.ts` ({@link makeNotify}).
   */
  notify: (job: Job, message: DiscordMessage) => Promise<void>;
}

/**
 * Build the default reporter. A Discord-originated job edits its waiting "⏳
 * working" reply via the interaction token; a tokenless job (idle self-teardown,
 * and the reconcile sweep / long-running nag) is announced to the channel
 * webhook. Both accept the same `{content, embeds}` body, so one DiscordMessage
 * serves both. The two transports are injected so the routing branch is testable.
 */
export function makeNotify(
  editOriginal: (token: string, message: DiscordMessage) => Promise<void>,
  postWebhook: (message: DiscordMessage) => Promise<void>,
): WorkerDeps['notify'] {
  return async (job: Job, message: DiscordMessage): Promise<void> => {
    if (job.interactionToken) {
      await editOriginal(job.interactionToken, message);
    } else {
      await postWebhook(message);
    }
  };
}

export async function handleJob(deps: WorkerDeps, job: Job): Promise<void> {
  try {
    switch (job.kind) {
      case 'start': {
        await deps.provider.start(job.id);
        await deps.notify(job, { embeds: [await startedEmbed(deps, job.id)] });
        break;
      }
      case 'stop': {
        // allowAlreadyStopped: an idle self-teardown may race a manual /stop, and
        // at-least-once Pub/Sub can redeliver a stop we already ran — both should
        // read as success, not a scary "failed" reply (SHORTCUTS #6d).
        await deps.provider.stop(job.id, { allowAlreadyStopped: true });
        await deps.notify(job, {
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
        await deps.notify(job, { embeds: [listEmbed(servers)] });
        break;
      }
      case 'sweep': {
        const report = await deps.provider.reconcile({
          maxUptimeHours: MAX_UPTIME_HOURS,
          autoStopUptimeHours: AUTOSTOP_UPTIME_HOURS,
        });
        // Stay quiet on an empty sweep — only speak up when something crossed the
        // line, so a 15-min cron doesn't post "nothing to do" all day.
        if (report.warned.length || report.stopped.length) {
          await deps.notify(job, { embeds: [sweepEmbed(report)] });
        }
        break;
      }
    }
  } catch (err) {
    const target =
      job.kind === 'list' ? 'servers' : job.kind === 'sweep' ? 'reconcile sweep' : job.id;
    await deps.notify(job, {
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
 * Reconcile-sweep thresholds (hours). `MAX_UPTIME` <= 0 disables the sweep;
 * `AUTOSTOP_UPTIME` <= 0 (or below MAX_UPTIME) means warn-only, never auto-stop.
 */
const MAX_UPTIME_HOURS = Number(process.env.ONEHOST_MAX_UPTIME_HOURS ?? 0);
const AUTOSTOP_UPTIME_HOURS = Number(process.env.ONEHOST_AUTOSTOP_UPTIME_HOURS ?? 0);

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
    return {
      title: 'No servers yet',
      description: 'Create one with the CLI first.',
      color: STATE_COLOR.STOPPED,
    };
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
 * Render a reconcile-sweep result: which long-running servers were auto-stopped
 * and which were merely flagged. Only built when at least one server crossed the
 * uptime ceiling (see handleJob), so it's never an empty "all clear" post.
 */
function sweepEmbed(report: ReconcileReport): Embed {
  const fields: Embed['fields'] = [];
  for (const s of report.stopped) {
    fields.push({
      name: `${STATE_ICON.STOPPED} ${s.id} auto-stopped`,
      value: `Up ${Math.floor(s.uptimeHours)}h — snapshotted + deleted to stop the bleed.`,
    });
  }
  for (const s of report.warned) {
    fields.push({
      name: `⚠️ ${s.id} still running`,
      value: `Up ${Math.floor(s.uptimeHours)}h. \`/stop ${s.id}\` when you're done.`,
    });
  }
  return {
    title: 'Long-running server sweep',
    color: report.stopped.length ? STATE_COLOR.STOPPED : STATE_COLOR.STARTING,
    fields,
  };
}
