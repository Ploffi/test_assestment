import {
  action,
  aggregatedAction,
  all,
  createEngine,
  createInMemoryAggregationStore,
  createInMemoryScheduledStore,
  integration,
  predicate,
  rule,
  scheduledAction,
  use,
} from '@air/engine';
import type {
  AggregationStore,
  AnyEventPayload,
  BaseCtx,
  CheckResult,
  Duration,
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
  githubApiUrl?: string;
  githubToken?: string;
  classifierUrl?: string;
  flakyCiWindow?: Duration;
  issueClosedQuietDelay?: Duration;
  issueClosedQuietDeadline?: Duration;
}

interface IssueClosedQuietPayload {
  closedDeliveryId: string;
  issueId: number;
  issueNumber: number;
  issueTitle: string;
  owner: string;
  repo: string;
  repository: string;
  url?: string;
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
      headBranch: ctx.event.workflow_run.head_branch,
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
        message: `${firstPr ? `PR #${firstPr.number}` : `Branch ${ctx.event.workflow_run.head_branch}`} had ${ctx.aggregate.count} failing CI runs within 1h`,
        url: ctx.event.workflow_run.html_url,
        aggregateCount: ctx.aggregate.count,
      });
    });

  const recordHostileComment = action('record_hostile_comment')
    .args(z.object({}))
    .fn(async (ctx) => {
      if (!('comment' in ctx.event) || !('issue' in ctx.event)) return;

      await store.add({
        deliveryId: ctx.deliveryId,
        eventName: 'issue_comment.created',
        ruleId: 'hostile-pr-comment',
        repository: repoName(ctx),
        message: `Hostile PR comment detected on #${ctx.event.issue.number}`,
        url: ctx.event.comment.html_url,
      });
    });

  const recordBreakingRelease = action('record_breaking_release')
    .args(z.object({}))
    .fn(async (ctx) => {
      if (!('release' in ctx.event)) return;

      await store.add({
        deliveryId: ctx.deliveryId,
        eventName: 'release.published',
        ruleId: 'breaking-release',
        repository: repoName(ctx),
        message: `Release ${ctx.event.release.tag_name} mentions a breaking change`,
        url: ctx.event.release.html_url,
      });
    });

  const recordIssueClosedQuiet = scheduledAction('record_issue_closed_quiet')
    .args(z.object({}))
    .fn(async (ctx) => {
      const payload = ctx.scheduled.payload as IssueClosedQuietPayload;

      await store.add({
        deliveryId: payload.closedDeliveryId,
        eventName: 'issues.closed',
        ruleId: 'issue-closed-quiet',
        repository: payload.repository,
        message: `Issue #${payload.issueNumber} stayed closed for ${String(opts.issueClosedQuietDelay ?? '5m')}`,
        url: payload.url,
      });
    });

  const classifier = integration('classifier')
    .cache({ ttl: '5m', max: 1_000 })
    .breaker({ errorThresholdPct: 50, resetMs: 30_000 })
    .concurrency(5)
    .retry({ attempts: 2, backoffMs: 100, jitter: false })
    .methods({
      classify: async (input: { text: string; signal?: AbortSignal }): Promise<{ label: string; confidence: number }> => {
        return classifyComment(input.text, opts.classifierUrl, input.signal);
      },
    });

  const isHostileComment = predicate('is_hostile_comment')
    .args(z.object({ minConfidence: z.number() }))
    .fn(async (ctx) => {
      if (!('comment' in ctx.event)) return false;
      const result = await ctx.integrations['classifier']?.['classify']({
        text: ctx.event.comment.body,
        signal: ctx.signal,
      });

      return result?.label === 'hostile' && result.confidence >= ctx.args.minConfidence;
    });

  const infraPrFromOutsider = rule('infra-pr-from-outsider')
    .on('pull_request.opened')
    .when(
      all(
        (ctx) => ctx.event.pull_request.base.ref === 'main',
        (ctx) => !store.coreTeam.has(ctx.event.pull_request.user.login),
        (ctx) => pullRequestTouchesInfra(ctx, opts),
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
      (
        ctx.event.workflow_run.pull_requests.length > 0 ||
        ctx.event.workflow_run.event === 'pull_request'
      ),
    )
    .aggregate({
      window: opts.flakyCiWindow ?? '1h',
      count: 3,
      key: (ctx) => {
        const firstPr = ctx.event.workflow_run.pull_requests[0];
        return String(firstPr?.id ?? ctx.event.workflow_run.head_branch ?? ctx.event.workflow_run.head_sha);
      },
    })
    .action('record_flaky_ci');

  const hostilePrComment = rule('hostile-pr-comment')
    .on('issue_comment.created')
    .when(
      all(
        (ctx) => Boolean(ctx.event.issue.pull_request),
        use('is_hostile_comment', { minConfidence: 0.8 }),
      ),
    )
    .action('record_hostile_comment');

  const breakingRelease = rule('breaking-release')
    .on('release.published')
    .when((ctx) =>
      /^v\d+\.\d+\.\d+$/.test(ctx.event.release.tag_name) &&
      (ctx.event.release.body ?? '').toLowerCase().includes('breaking change'),
    )
    .action('record_breaking_release');

  const issueClosedQuiet = rule('issue-closed-quiet')
    .on('issues.closed')
    .when(() => true)
    .schedule({
      delay: opts.issueClosedQuietDelay ?? '5m',
      deadline: opts.issueClosedQuietDeadline ?? '10m',
      key: (ctx) => `${repoName(ctx) ?? 'unknown'}#${ctx.event.issue.number}`,
      transform: (ctx): IssueClosedQuietPayload => {
        const repository = repoName(ctx) ?? ctx.event.repository.full_name;
        const [owner = '', repo = ''] = repository.split('/');

        return {
          closedDeliveryId: ctx.deliveryId,
          issueId: ctx.event.issue.id,
          issueNumber: ctx.event.issue.number,
          issueTitle: ctx.event.issue.title,
          owner,
          repo,
          repository,
          url: ctx.event.issue.html_url,
        };
      },
      check: async (ctx): Promise<CheckResult> => {
        const payload = ctx.payload as IssueClosedQuietPayload;
        const state = await fetchGitHubIssueState(payload, opts.githubToken, opts.githubApiUrl, ctx.signal);

        if (state === 'closed') return { kind: 'pass' };
        if (state === 'open') return { kind: 'skip' };
        return { kind: 'recheck', after: '10s' };
      },
    })
    .action('record_issue_closed_quiet');

  const engine = createEngine({
    aggregationStore: opts.aggregationStore ?? createInMemoryAggregationStore(),
    scheduledStore: opts.scheduledStore ?? createInMemoryScheduledStore(),
    logger,
  });

  engine.register({
    integrations: [classifier],
    predicates: [isHostileComment()],
    actions: [
      recordInfraPr({}),
      recordDemoComment({}),
      recordHostileComment({}),
      recordBreakingRelease({}),
    ],
    aggregatedActions: [recordFlakyCi({})],
    scheduledActions: [recordIssueClosedQuiet({})],
    rules: [
      infraPrFromOutsider({}),
      demoCommentCommand({}),
      flakyCiOnPr({}),
      hostilePrComment({}),
      breakingRelease({}),
      issueClosedQuiet({}),
    ],
  });

  return engine;
}

function repoName(ctx: BaseCtx<AnyEventPayload, unknown>): string | undefined {
  return ctx.repo?.fullName;
}

async function pullRequestTouchesInfra(
  ctx: BaseCtx<Extract<AnyEventPayload, { pull_request: unknown }>, unknown>,
  opts: DemoEngineStoreOptions,
): Promise<boolean> {
  const pr = ctx.event.pull_request as {
    files?: Array<{ filename?: string }>;
    head?: { ref?: string };
    number?: number;
    title?: string;
  };

  if (pr.files?.some((file) => file.filename?.startsWith('infra/'))) return true;

  const repository = repoName(ctx) ?? ('repository' in ctx.event ? ctx.event.repository.full_name : undefined);
  if (repository && typeof pr.number === 'number') {
    const files = await fetchGitHubPullRequestFiles(repository, pr.number, opts, ctx.signal);
    if (files?.some((file) => file.startsWith('infra/'))) return true;
  }

  return Boolean(
    !opts.githubToken &&
    (pr.head?.ref?.startsWith('infra/') || pr.title?.toLowerCase().includes('infra')),
  );
}

async function fetchGitHubPullRequestFiles(
  repository: string,
  pullNumber: number,
  opts: DemoEngineStoreOptions,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  if (!opts.githubToken) return undefined;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return undefined;
  const baseUrl = opts.githubApiUrl ?? 'https://api.github.com';

  try {
    const response = await fetch(
      `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files`,
      {
        headers: githubHeaders(opts.githubToken),
        signal,
      },
    );

    if (!response.ok) return undefined;
    const body = await response.json() as Array<{ filename?: unknown }>;
    return body.flatMap((file) => typeof file.filename === 'string' ? [file.filename] : []);
  } catch {
    return undefined;
  }
}

async function classifyComment(
  text: string,
  classifierUrl: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ label: string; confidence: number }> {
  if (!classifierUrl) {
    return text.toLowerCase().includes('[hostile]')
      ? { label: 'hostile', confidence: 0.95 }
      : { label: 'ok', confidence: 0.95 };
  }

  const response = await fetch(classifierUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) return { label: 'ok', confidence: 0 };
  const body = await response.json() as { label?: unknown; confidence?: unknown };
  return {
    label: typeof body.label === 'string' ? body.label : 'ok',
    confidence: typeof body.confidence === 'number' ? body.confidence : 0,
  };
}

async function fetchGitHubIssueState(
  payload: IssueClosedQuietPayload,
  token: string | undefined,
  apiUrl: string | undefined,
  signal: AbortSignal,
): Promise<'open' | 'closed' | 'unknown'> {
  if (!token || !payload.owner || !payload.repo) return 'unknown';
  const baseUrl = apiUrl ?? 'https://api.github.com';

  try {
    const response = await fetch(
      `${baseUrl}/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/issues/${payload.issueNumber}`,
      {
        headers: {
          ...githubHeaders(token),
        },
        signal,
      },
    );

    if (!response.ok) return 'unknown';
    const body = await response.json() as { state?: unknown };
    return body.state === 'open' || body.state === 'closed' ? body.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'air-demo-rule-engine',
    'x-github-api-version': '2022-11-28',
  };
}
