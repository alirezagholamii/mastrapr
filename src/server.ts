import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadConfig } from './utils/config.js';
import type { Config } from './utils/config.js';
import { verifySignature } from './utils/verifySignature.js';
import type { ReviewJob, ReviewOutcome } from './types/index.js';

type Runner = (job: ReviewJob, signal: AbortSignal) => Promise<ReviewOutcome>;
const issueCommentSchema = z.object({
  action: z.literal('created'),
  repository: z.object({ name: z.string().min(1), owner: z.object({ login: z.string().min(1) }) }),
  issue: z.object({ number: z.number().int().positive(), pull_request: z.object({}).passthrough() }),
  comment: z.object({ body: z.string(), user: z.object({ login: z.string(), type: z.literal('User') }) }),
  sender: z.object({ login: z.string() }),
});

function lazyRunner(config: Config): Runner {
  let runner: Promise<Runner> | undefined;
  return async (job, signal) => {
    runner ??= Promise.all([import('./workflows/prReview.js'), import('./utils/github.js')])
      .then(([workflow, github]) => workflow.createReviewRunner(config, { github: github.createGitHubClient(config) }))
      .catch(error => { runner = undefined; throw error; });
    signal.throwIfAborted();
    return (await runner)(job, signal);
  };
}

export function buildServer(config: Config, options: { runner?: Runner; logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]'],
    },
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    requestTimeout: 15000,
  });
  const runner = options.runner ?? lazyRunner(config);
  const queue: ReviewJob[] = [];
  const pending = new Set<string>();
  const deliveries = new Map<string, number>();
  const shutdown = new AbortController();
  let draining: Promise<void> | undefined;
  let closing = false;
  const keyFor = (job: ReviewJob) => `${job.owner}/${job.repo}#${job.pullNumber}`.toLowerCase();

  async function drain() {
    while (queue.length && !closing) {
      const job = queue.shift()!;
      const controller = new AbortController();
      const abort = () => controller.abort();
      shutdown.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, config.REVIEW_TIMEOUT_MS);
      timeout.unref();
      try {
        const outcome = await runner(job, controller.signal);
        app.log.info({ deliveryId: job.deliveryId, status: outcome.status, reason: outcome.reason }, 'Review completed');
      } catch {
        deliveries.delete(job.deliveryId);
        // Do not log provider/Octokit errors: they can contain credentials and source code.
        app.log.error({ deliveryId: job.deliveryId, timedOut: controller.signal.aborted }, 'Review failed; retry with /review or redeliver the webhook');
      } finally {
        clearTimeout(timeout);
        shutdown.signal.removeEventListener('abort', abort);
        pending.delete(keyFor(job));
      }
    }
  }

  function startDrain() {
    if (draining || closing) return;
    draining = drain().finally(() => {
      draining = undefined;
      // A request may enqueue between drain completion and this continuation.
      if (queue.length) startDrain();
    });
  }

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/webhook', async (request, reply) => {
    const body = request.body;
    const signature = request.headers['x-hub-signature-256'];
    if (!Buffer.isBuffer(body) || !verifySignature(body, typeof signature === 'string' ? signature : undefined, config.GITHUB_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'Invalid webhook signature' });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      return reply.code(415).send({ error: 'Use application/json' });
    }
    let payload: unknown;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch { return reply.code(400).send({ error: 'Invalid JSON' }); }
    const event = request.headers['x-github-event'];
    if (event === 'ping') return { status: 'pong' };
    if (event !== 'issue_comment') return reply.code(202).send({ status: 'ignored' });
    const parsed = issueCommentSchema.safeParse(payload);
    if (!parsed.success) return reply.code(202).send({ status: 'ignored' });
    const data = parsed.data;
    if (!/^\s*\/review\s*$/.test(data.comment.body) || data.sender.login !== data.comment.user.login) {
      return reply.code(202).send({ status: 'ignored' });
    }
    const owner = data.repository.owner.login;
    const repo = data.repository.name;
    if (!config.GITHUB_REPOSITORIES.includes(`${owner}/${repo}`.toLowerCase())) {
      return reply.code(202).send({ status: 'ignored' });
    }
    const deliveryId = request.headers['x-github-delivery'];
    if (typeof deliveryId !== 'string' || !/^[\w-]{1,128}$/.test(deliveryId)) {
      return reply.code(400).send({ error: 'Missing or invalid delivery ID' });
    }
    const now = Date.now();
    for (const [id, at] of deliveries) if (now - at > 86400000) deliveries.delete(id);
    const job: ReviewJob = { owner, repo, pullNumber: data.issue.number, requestedBy: data.comment.user.login, deliveryId };
    if (deliveries.has(deliveryId) || pending.has(keyFor(job))) {
      return reply.code(202).send({ status: 'duplicate' });
    }
    if (closing || pending.size >= config.MAX_QUEUE_SIZE) {
      return reply.header('Retry-After', '30').code(503).send({ error: 'Review queue full; redeliver later' });
    }
    if (deliveries.size >= 1000) deliveries.delete(deliveries.keys().next().value!);
    deliveries.set(deliveryId, now);
    pending.add(keyFor(job));
    queue.push(job);
    startDrain();
    return reply.code(202).send({ status: 'queued' });
  });
  app.addHook('preClose', async () => {
    closing = true;
    shutdown.abort();
    queue.length = 0;
    await draining;
  });
  return app;
}

async function main() {
  const config = loadConfig();
  const app = buildServer(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
  }
  await app.listen({ host: config.HOST, port: config.PORT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Invalid configuration:')
      ? error.message : 'Server startup failed. Check configuration and port availability.');
    process.exitCode = 1;
  });
}
