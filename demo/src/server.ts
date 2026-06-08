import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AggregationStore,
  Duration,
  EventEnvelope,
  RuleEngine,
  ScheduledStore,
  WebhookEventName,
} from '@air/engine';
import type { Logger as PinoLogger } from 'pino';

import { asEngineLogger, createDemoLogger } from './logger.js';
import {
  createDemoEngine,
  createDemoStore,
  type DemoStore,
} from './rules.js';
import {
  createDashboardRecorder,
  renderDashboard,
  subscribeDashboardToEngine,
  type DashboardRecorder,
} from './dashboard.js';

export interface DemoApp {
  app: FastifyInstance;
  engine: RuleEngine;
  store: DemoStore;
  dashboard: DashboardRecorder;
}

export interface DemoAppOptions {
  webhookSecret?: string;
  store?: DemoStore;
  engine?: RuleEngine;
  logger?: PinoLogger;
  aggregationStore?: AggregationStore;
  scheduledStore?: ScheduledStore;
  dashboard?: DashboardRecorder;
  githubApiUrl?: string;
  githubToken?: string;
  classifierUrl?: string;
  flakyCiWindow?: Duration;
  issueClosedQuietDelay?: Duration;
  issueClosedQuietDeadline?: Duration;
}

const supportedEventNames = new Set<WebhookEventName>([
  'pull_request.opened',
  'pull_request.closed',
  'pull_request.synchronize',
  'pull_request.reopened',
  'pull_request.ready_for_review',
  'pull_request_review.submitted',
  'issues.opened',
  'issues.closed',
  'issues.reopened',
  'issues.edited',
  'issue_comment.created',
  'issue_comment.edited',
  'workflow_run.completed',
  'workflow_run.requested',
  'check_run.completed',
  'push',
  'release.published',
  'release.edited',
]);

export function createApp(opts: DemoAppOptions = {}): DemoApp {
  const store = opts.store ?? createDemoStore();
  const logger = opts.logger ?? createDemoLogger();
  const dashboard = opts.dashboard ?? createDashboardRecorder();
  const engine = opts.engine ?? createDemoEngine(
    store,
    asEngineLogger(logger.child({ component: 'engine' })),
    {
      aggregationStore: opts.aggregationStore,
      scheduledStore: opts.scheduledStore,
      githubApiUrl: opts.githubApiUrl,
      githubToken: opts.githubToken,
      classifierUrl: opts.classifierUrl,
      flakyCiWindow: opts.flakyCiWindow,
      issueClosedQuietDelay: opts.issueClosedQuietDelay,
      issueClosedQuietDeadline: opts.issueClosedQuietDeadline,
    },
  );
  subscribeDashboardToEngine(engine, dashboard);
  const app = Fastify({
    loggerInstance: logger.child({ component: 'http' }) as unknown as FastifyBaseLogger,
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/demo/notifications', async () => ({ notifications: await store.list() }));

  app.get('/demo/dashboard/data', async () => ({
    notifications: await store.list(),
    logs: dashboard.logs(),
    webhookEvents: dashboard.webhookEvents(),
    engineEvents: dashboard.engineEvents(),
  }));

  app.get('/demo/dashboard', async (_request, reply) => {
    return reply.type('text/html').send(renderDashboard({
      notifications: await store.list(),
      logs: dashboard.logs(),
      webhookEvents: dashboard.webhookEvents(),
      engineEvents: dashboard.engineEvents(),
    }));
  });

  app.addHook('onResponse', async (request, reply) => {
    dashboard.recordLog({
      level: reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info',
      message: `${request.method} ${request.url} ${reply.statusCode}`,
      details: {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
      },
    });
  });

  app.addHook('onError', async (request, _reply, err) => {
    dashboard.recordLog({
      level: 'error',
      message: `${request.method} ${request.url} failed`,
      details: { name: err.name, message: err.message, stack: err.stack },
    });
  });

  app.post('/github/webhook', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const githubEvent = firstHeader(request.headers['x-github-event']);
    const deliveryId = firstHeader(request.headers['x-github-delivery']);
    const signature = firstHeader(request.headers['x-hub-signature-256']);

    if (!githubEvent || !deliveryId) {
      dashboard.recordWebhookEvent({
        deliveryId,
        githubEvent,
        outcome: 'rejected',
        statusCode: 400,
        reason: 'missing GitHub webhook headers',
      });
      return reply.code(400).send({ ok: false, error: 'missing GitHub webhook headers' });
    }

    if (!verifySignature(rawBody, signature, opts.webhookSecret)) {
      dashboard.recordWebhookEvent({
        deliveryId,
        githubEvent,
        outcome: 'rejected',
        statusCode: 401,
        reason: 'invalid signature',
      });
      return reply.code(401).send({ ok: false, error: 'invalid signature' });
    }

    const payload = parseJson(rawBody);
    if (payload === undefined) {
      dashboard.recordWebhookEvent({
        deliveryId,
        githubEvent,
        outcome: 'rejected',
        statusCode: 400,
        reason: 'invalid JSON payload',
      });
      return reply.code(400).send({ ok: false, error: 'invalid JSON payload' });
    }

    const name = toEngineEventName(githubEvent, payload);
    if (!name) {
      dashboard.recordWebhookEvent({
        deliveryId,
        githubEvent,
        outcome: 'ignored',
        statusCode: 202,
        reason: 'unsupported event',
        payload,
      });
      return reply.code(202).send({
        ok: true,
        ignored: true,
        reason: 'unsupported event',
        deliveryId,
        githubEvent,
      });
    }

    const envelope = {
      name,
      payload,
      deliveryId,
    } as EventEnvelope;

    try {
      // This demo evaluates inline before acknowledging. A production ingress
      // should usually persist or enqueue first, then add retries/dead letters
      // around asynchronous evaluation and downstream actions.
      await engine.evaluate(envelope);
    } catch {
      dashboard.recordWebhookEvent({
        deliveryId,
        githubEvent,
        engineEvent: name,
        outcome: 'failed',
        statusCode: 500,
        reason: 'evaluation failed',
        payload,
      });
      return reply.code(500).send({ ok: false, error: 'evaluation failed', deliveryId });
    }

    dashboard.recordWebhookEvent({
      deliveryId,
      githubEvent,
      engineEvent: name,
      outcome: 'accepted',
      statusCode: 202,
      payload,
    });
    return reply.code(202).send({ ok: true, ignored: false, deliveryId, event: name });
  });

  return { app, engine, store, dashboard };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(rawBody: string): unknown | undefined {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function toEngineEventName(githubEvent: string, payload: unknown): WebhookEventName | undefined {
  const action = payloadAction(payload);
  const actionName = action ? `${githubEvent}.${action}` : githubEvent;

  if (isSupportedEventName(actionName)) return actionName;
  if (isSupportedEventName(githubEvent)) return githubEvent;
  return undefined;
}

function payloadAction(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const action = (payload as { action?: unknown }).action;
  return typeof action === 'string' ? action : undefined;
}

function isSupportedEventName(name: string): name is WebhookEventName {
  return supportedEventNames.has(name as WebhookEventName);
}

function verifySignature(rawBody: string, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!signature?.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);

  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
