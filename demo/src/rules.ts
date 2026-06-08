import {
  action,
  aggregatedAction,
  all,
  createEngine,
  createInMemoryAggregationStore,
  createInMemoryScheduledStore,
  rule,
} from '@air/engine';
import type {
  AggregationStore,
  AnyEventPayload,
  BaseCtx,
  Logger,
  RuleEngine,
  ScheduledStore,
} from '@air/engine';
import { z } from 'zod';

import { asEngineLogger, createDemoLogger } from './logger.js';

export interface DemoNotification {
  id: number;
  deliveryId: string;
  eventName: string;
  ruleId: string;
  repository?: string;
  message: string;
  url?: string;
  aggregateCount?: number;
  createdAt: string;
}

export interface DemoStore {
  readonly coreTeam: Set<string>;
  add(input: Omit<DemoNotification, 'id' | 'createdAt'>): DemoNotification | Promise<DemoNotification>;
  list(): DemoNotification[] | Promise<DemoNotification[]>;
  clear(): void | Promise<void>;
}

export interface DemoEngineStoreOptions {
  aggregationStore?: AggregationStore;
  scheduledStore?: ScheduledStore;
}

export function createDemoStore(opts: { coreTeam?: Iterable<string> } = {}): DemoStore {
  const notifications: DemoNotification[] = [];
  let nextId = 1;

  return {
    coreTeam: new Set(opts.coreTeam ?? ['alice', 'octocat']),
    add(input) {
      const notification = {
        ...input,
        id: nextId++,
        createdAt: new Date().toISOString(),
      };
      notifications.push(notification);
      return notification;
    },
    list() {
      return notifications.slice();
    },
    clear() {
      notifications.length = 0;
      nextId = 1;
    },
  };
}

export function createDemoEngine(
  store: DemoStore = createDemoStore(),
  logger: Logger = asEngineLogger(createDemoLogger().child({ component: 'engine' })),
  opts: DemoEngineStoreOptions = {},
): RuleEngine {
  const recordInfraPr = action('record_infra_pr')
    .args(z.object({}))
    .fn(async (ctx) => {
      if (!('pull_request' in ctx.event)) return;
      const pr = ctx.event.pull_request;

      await store.add({
        deliveryId: ctx.deliveryId,
        eventName: 'pull_request.opened',
        ruleId: 'infra-pr-from-outsider',
        repository: repoName(ctx),
        message: `PR #${pr.number} targets main and looks infrastructure-related`,
        url: pr.html_url,
      });
    });

  const recordDemoComment = action('record_demo_comment')
    .args(z.object({}))
    .fn(async (ctx) => {
      if (!('comment' in ctx.event) || !('issue' in ctx.event)) return;

      await store.add({
        deliveryId: ctx.deliveryId,
        eventName: 'issue_comment.created',
        ruleId: 'demo-comment-command',
        repository: repoName(ctx),
        message: `Demo command received on issue #${ctx.event.issue.number}`,
        url: ctx.event.comment.html_url,
      });
    });

  const recordFlakyCi = aggregatedAction('record_flaky_ci')
    .on('workflow_run.completed')
    .args(z.object({}))
    .transform((ctx) => ({
      runId: ctx.event.workflow_run.id,
      url: ctx.event.workflow_run.html_url,
      pullRequests: ctx.event.workflow_run.pull_requests.map((pr) => pr.number),
    }))
    .fn(async (ctx) => {
      const firstPr = ctx.event.workflow_run.pull_requests[0];

      await store.add({
        deliveryId: ctx.deliveryId,
        eventName: 'workflow_run.completed',
        ruleId: 'flaky-ci-on-pr',
        repository: repoName(ctx),
        message: `PR #${firstPr?.number ?? 'unknown'} had ${ctx.aggregate.count} failing CI runs within 1h`,
        url: ctx.event.workflow_run.html_url,
        aggregateCount: ctx.aggregate.count,
      });
    });

  const infraPrFromOutsider = rule('infra-pr-from-outsider')
    .on('pull_request.opened')
    .when(
      all(
        (ctx) => ctx.event.pull_request.base.ref === 'main',
        (ctx) => !store.coreTeam.has(ctx.event.pull_request.user.login),
        (ctx) => {
          const pr = ctx.event.pull_request;
          return pr.head.ref.startsWith('infra/') || pr.title.toLowerCase().includes('infra');
        },
      ),
    )
    .action('record_infra_pr');

  const demoCommentCommand = rule('demo-comment-command')
    .on('issue_comment.created')
    .when((ctx) => ctx.event.comment.body.includes('/air-demo'))
    .action('record_demo_comment');

  const flakyCiOnPr = rule('flaky-ci-on-pr')
    .on('workflow_run.completed')
    .when((ctx) =>
      ctx.event.workflow_run.conclusion === 'failure' &&
      ctx.event.workflow_run.pull_requests.length > 0,
    )
    .aggregate({
      window: '1h',
      count: 3,
      key: (ctx) => {
        const firstPr = ctx.event.workflow_run.pull_requests[0];
        return String(firstPr?.id ?? ctx.event.workflow_run.head_sha);
      },
    })
    .action('record_flaky_ci');

  const engine = createEngine({
    aggregationStore: opts.aggregationStore ?? createInMemoryAggregationStore(),
    scheduledStore: opts.scheduledStore ?? createInMemoryScheduledStore(),
    logger,
  });

  engine.register({
    actions: [recordInfraPr({}), recordDemoComment({})],
    aggregatedActions: [recordFlakyCi({})],
    rules: [infraPrFromOutsider({}), demoCommentCommand({}), flakyCiOnPr({})],
  });

  return engine;
}

function repoName(ctx: BaseCtx<AnyEventPayload, unknown>): string | undefined {
  return ctx.repo?.fullName;
}
