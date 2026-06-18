/**
 * The control-plane hand-off seam. The Discord interactions endpoint must ACK
 * within 3 seconds, but starting/stopping a VM takes minutes — so it publishes a
 * Job and returns, and an off-box worker does the slow work and edits the Discord
 * message when done.
 *
 * A `Job` is the message that crosses that gap. `JobPublisher` is the seam:
 * `PubSubPublisher` in production (Cloud Run -> Pub/Sub topic -> Cloud Run push),
 * `HttpPublisher` for local dev (interactions posts straight at the worker, no
 * GCP). The same topic is where the idle-agent's stop signal will land later
 * (see IDEAS.md "Idle self-teardown").
 */

/**
 * `interactionToken` ties a job back to a waiting Discord reply so the worker can
 * edit it in place. It is **optional**: jobs that originate off-Discord — an idle
 * VM's self-teardown signal (a plain `{kind:'stop',id}`), or a future reconcile
 * sweep / long-running-server nag — carry no token, and the worker routes their
 * result to the channel webhook instead (see apps/worker `notify`).
 */
export type Job =
  | { kind: 'start'; id: string; interactionToken?: string }
  | { kind: 'stop'; id: string; interactionToken?: string }
  | { kind: 'list'; interactionToken?: string };

export interface JobPublisher {
  publish(job: Job): Promise<void>;
}

/**
 * Production transport. Publishes onto a Pub/Sub topic; a push subscription
 * delivers each message to the worker's HTTP endpoint as a {@link parsePushBody}
 * envelope. At-least-once delivery gives us free retries if the worker is cold
 * or crashes mid-job.
 */
export class PubSubPublisher implements JobPublisher {
  // Lazily constructed so importing this module costs nothing until first use
  // (keeps the local HTTP path from pulling in the GCP client).
  private topic: import('@google-cloud/pubsub').Topic | undefined;

  constructor(
    private readonly topicName: string,
    private readonly projectId?: string,
  ) {}

  private async getTopic(): Promise<import('@google-cloud/pubsub').Topic> {
    if (this.topic === undefined) {
      const { PubSub } = await import('@google-cloud/pubsub');
      const client = new PubSub(this.projectId ? { projectId: this.projectId } : {});
      this.topic = client.topic(this.topicName);
    }
    return this.topic;
  }

  async publish(job: Job): Promise<void> {
    const topic = await this.getTopic();
    await topic.publishMessage({ json: job });
  }
}

/**
 * Local-dev transport: POST the job straight at the worker in the same envelope
 * Pub/Sub push uses, so the worker code path is identical. Fire-and-forget — the
 * worker processes the job *before* it responds (mirroring a push subscription,
 * which on Cloud Run must finish work before acking, since CPU is only allocated
 * during the request). Awaiting that here would blow Discord's 3-second window,
 * so we hand off and don't wait. Not for production.
 */
export class HttpPublisher implements JobPublisher {
  constructor(private readonly workerUrl: string) {}

  async publish(job: Job): Promise<void> {
    const data = Buffer.from(JSON.stringify(job)).toString('base64');
    void fetch(this.workerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { data } }),
    }).catch((err: unknown) => {
      console.error('http job publish failed:', err);
    });
  }
}

/** Pick a transport from env. `JOB_TRANSPORT=http` + `WORKER_URL` for local dev. */
export function publisherFromEnv(): JobPublisher {
  if ((process.env.JOB_TRANSPORT ?? 'pubsub') === 'http') {
    const workerUrl = process.env.WORKER_URL;
    if (!workerUrl) throw new Error('JOB_TRANSPORT=http requires WORKER_URL');
    return new HttpPublisher(workerUrl);
  }
  const topicName = process.env.PUBSUB_TOPIC ?? 'onehost-jobs';
  return new PubSubPublisher(topicName, process.env.GCP_PROJECT_ID);
}

/**
 * Decode a Pub/Sub push request body (or the HttpPublisher envelope) into a Job.
 * Push delivers `{ message: { data: <base64 JSON> }, subscription }`.
 */
export function parsePushBody(raw: string): Job {
  const body = JSON.parse(raw) as { message?: { data?: unknown } };
  const data = body.message?.data;
  if (typeof data !== 'string') throw new Error('push body missing message.data');
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as Job;
}
