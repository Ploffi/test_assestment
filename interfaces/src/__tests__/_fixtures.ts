/**
 * Shared fixtures used across smoke / integration tests.
 *
 * Defines a small reusable set of predicates, actions, integrations,
 * and rules that mirror the ADR examples (infra PR, flaky CI, hostile
 * comment, quiet-close). Tests compose these by registering subsets.
 */

import { z } from 'zod';
import {
  predicate,
  action,
  aggregatedAction,
  scheduledAction,
  rule,
  integration,
  all,
  not,
  use,
} from './_harness.js';

/* ============================================================ *
 * Integrations
 * ============================================================ */

export const classifier = integration('classifier')
  .cache({ ttl: '24h', max: 10_000 })
  .breaker({ errorThresholdPct: 50, resetMs: 30_000 })
  .concurrency(10)
  .retry({ attempts: 3, backoffMs: 200, jitter: true })
  .methods({
    classify: async (input: {
      text: string;
      signal?: AbortSignal;
    }): Promise<{ label: string; confidence: number }> => {
      void input;
      return { label: 'ok', confidence: 1 };
    },
  });

export const slack = integration('slack')
  .breaker({ errorThresholdPct: 50, resetMs: 30_000 })
  .concurrency(5)
  .retry({ attempts: 2, backoffMs: 500, jitter: true })
  .methods({
    post: async (input: {
      channel: string;
      text: string;
      signal?: AbortSignal;
    }): Promise<void> => {
      void input;
    },
  });

/* ============================================================ *
 * Predicates
 * ============================================================ */

export const isTeamMember = predicate('is_team_member')
  .args(z.object({ team: z.string(), login: z.string() }))
  .fn(async (ctx) => ctx.args.team !== 'none' && ctx.args.login !== '');

export const touchesPaths = predicate('touches_paths')
  .args(z.object({ glob: z.string() }))
  .fn(async (ctx) => ctx.args.glob.length > 0);

export const isHostileComment = predicate('is_hostile_comment')
  .args(
    z.object({
      minConfidence: z.number(),
      minCommentLength: z.number().optional(),
    }),
  )
  .fn(async (ctx) => {
    void ctx.signal;
    return ctx.args.minConfidence > 0.5;
  });

/* ============================================================ *
 * Plain actions
 * ============================================================ */

export const notifySlack = action('notify-slack')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    void ctx.args.channel;
  });

export const openLinearTicket = action('open-linear-ticket')
  .args(z.object({ team: z.string() }))
  .fn(async (ctx) => {
    void ctx.args.team;
  });

/* ============================================================ *
 * Aggregated action (ADR-006)
 * ============================================================ */

export const notifyFlakyRuns = aggregatedAction('notify-flaky-runs')
  .on('workflow_run.completed')
  .args(z.object({ channel: z.string() }))
  .transform((ctx) => ({
    runUrl: ctx.event.workflow_run.html_url,
    conclusion: ctx.event.workflow_run.conclusion,
    headSha: ctx.event.workflow_run.head_sha,
  }))
  .fn(async (ctx) => {
    void ctx.args.channel;
    void ctx.aggregate.entries;
    void ctx.aggregate.count;
  });

/* ============================================================ *
 * Scheduled action (ADR-007)
 * ============================================================ */

export const notifyQuietClose = scheduledAction('notify-quiet-close')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    void ctx.args.channel;
    void ctx.scheduled.payload;
    void ctx.scheduled.scheduledAt;
    void ctx.scheduled.ranAt;
  });

/* ============================================================ *
 * Rules
 * ============================================================ */

export const infraPrFromOutsider = rule('infra-pr-from-outsider')
  .on('pull_request.opened')
  .when(
    all(
      (ctx) => ctx.event.pull_request.base.ref === 'main',
      not(
        use('is_team_member', {
          team: 'core',
          login: (ctx: any) => ctx.event.pull_request.user.login,
        }),
      ),
      use('touches_paths', { glob: 'infra/**' }),
    ),
  )
  .action('notify-slack');

export const flakyPrCi = rule('flaky-pr-ci')
  .on('workflow_run.completed')
  .when((ctx) =>
    ctx.event.workflow_run.conclusion === 'failure' &&
    ctx.event.workflow_run.pull_requests.length > 0,
  )
  .aggregate({
    window: '1h',
    count: 3,
    key: (ctx) => String(ctx.event.workflow_run.pull_requests[0]?.id ?? 0),
  })
  .action('notify-flaky-runs');

export const hostilePrComment = rule('hostile-pr-comment')
  .args(z.object({ allowedAuthors: z.array(z.string()) }))
  .on('issue_comment.created')
  .when(
    all(
      (ctx) => !ctx.args.allowedAuthors.includes(ctx.event.comment.user.login),
      use('is_hostile_comment', { minConfidence: 0.8 }),
    ),
  )
  .action('notify-slack');

export const issueClosedQuiet = rule('issue-closed-quiet')
  .on('issues.closed')
  .when((ctx) => ctx.event.issue.state_reason !== 'duplicate')
  .schedule({
    delay: '5m',
    deadline: '1h',
    key: (ctx) => String(ctx.event.issue.id),
    transform: (ctx) => ({
      issueId: ctx.event.issue.id,
      url: ctx.event.issue.html_url,
      repo: ctx.event.repository.full_name,
    }),
    check: async () => ({ kind: 'pass' }),
  })
  .action('notify-quiet-close');
