/**
 * Type-only smoke check. Not a unit test — exists only so `tsc --noEmit`
 * exercises the builder shapes end-to-end with declared (not implemented)
 * factory functions. If this file compiles, the public types compose.
 *
 * Mirrors the worked examples from ADR-002 (predicate + rule),
 * ADR-005 (integration), ADR-006 (aggregated action + rule), and
 * ADR-007 (scheduled action + rule).
 */

import { z } from 'zod';
import type {
  DefinePredicate,
  DefineAction,
  DefineAggregatedAction,
  DefineScheduledAction,
  DefineRule,
  DefineIntegration,
  AllFactory,
  NotFactory,
  UseFactory,
  RuleEngine,
  EngineOptions,
  EventEnvelope,
  RegisteredRule,
  RegisteredPredicate,
  RegisteredAction,
  RegisteredAggregatedAction,
  RegisteredScheduledAction,
  RegisteredIntegration,
  CheckResult,
} from '../public/index.js';

/* ============================================================ *
 * Declared (not implemented) factories — stand-ins for what the
 * engine package will export. Types only; never invoked at runtime.
 * ============================================================ */

declare const predicate: DefinePredicate;
declare const action: DefineAction;
declare const aggregatedAction: DefineAggregatedAction;
declare const scheduledAction: DefineScheduledAction;
declare const rule: DefineRule;
declare const integration: DefineIntegration;
declare const all: AllFactory;
declare const not: NotFactory;
declare const use: UseFactory;
declare const RuleEngineCtor: new (opts?: EngineOptions) => RuleEngine;

/* ============================================================ *
 * Integration (ADR-005)
 * ============================================================ */

const classifier = integration('classifier')
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

const slack = integration('slack')
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

const _intCheck1: RegisteredIntegration = classifier;
const _intCheck2: RegisteredIntegration = slack;

/* ============================================================ *
 * Predicate (ADR-002, ADR-004)
 * ============================================================ */

const isTeamMember = predicate('is_team_member')
  .args(z.object({ team: z.string(), login: z.string() }))
  .fn(async (ctx) => {
    const _team: string = ctx.args.team;
    const _login: string = ctx.args.login;
    return true;
  });

const touchesPaths = predicate('touches_paths')
  .args(z.object({ glob: z.string() }))
  .fn(async (ctx) => {
    const _glob: string = ctx.args.glob;
    return true;
  });

const isHostileComment = predicate('is_hostile_comment')
  .args(
    z.object({
      minConfidence: z.number(),
      minCommentLength: z.number().optional(),
    }),
  )
  .fn(async (ctx) => {
    const _conf: number = ctx.args.minConfidence;
    // ctx.signal threads through
    void ctx.signal;
    void ctx.deliveryId;
    void ctx.logger;
    return true;
  });

const _predCheck: RegisteredPredicate = isTeamMember();

/* ============================================================ *
 * Plain action (ADR-002)
 * ============================================================ */

const notifySlack = action('notify-slack')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    const _channel: string = ctx.args.channel;
    void ctx.event;
    void ctx.integrations;
  });

const _actCheck: RegisteredAction = notifySlack({ channel: '#moderation' });

/* ============================================================ *
 * Aggregated action (ADR-006)
 * ============================================================ */

const notifyFlakyRuns = aggregatedAction('notify-flaky-runs')
  .on('workflow_run.completed')
  .args(z.object({ channel: z.string() }))
  .transform((ctx) => ({
    runUrl: ctx.event.workflow_run.html_url,
    conclusion: ctx.event.workflow_run.conclusion,
    headSha: ctx.event.workflow_run.head_sha,
  }))
  .fn(async (ctx) => {
    const _channel: string = ctx.args.channel;
    const _count: number = ctx.aggregate.count;
    for (const e of ctx.aggregate.entries) {
      void e.at;
      void e.payload;
    }
  });

const _aggCheck: RegisteredAggregatedAction = notifyFlakyRuns({ channel: '#ci' });

/* ============================================================ *
 * Scheduled action (ADR-007)
 * ============================================================ */

const notifyQuietClose = scheduledAction('notify-quiet-close')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    const _channel: string = ctx.args.channel;
    void ctx.scheduled.payload;
    void ctx.scheduled.scheduledAt;
    void ctx.scheduled.ranAt;
  });

const _schedCheck: RegisteredScheduledAction = notifyQuietClose({ channel: '#triage' });

/* ============================================================ *
 * Plain rule with .when tree (ADR-002)
 * ============================================================ */

const infraPrFromOutsider = rule('infra-pr-from-outsider')
  .on('pull_request.opened')
  .when(
    all(
      (ctx) => ctx.event.pull_request.base.ref === 'main',
      not(
        use('is_team_member', {
          team: 'core',
          login: (ctx) => ctx.event.pull_request.user.login,
        }),
      ),
      use('touches_paths', { glob: 'infra/**' }),
    ),
  )
  .action('notify-slack');

const _ruleCheck1: RegisteredRule = infraPrFromOutsider();

/* ============================================================ *
 * Aggregating rule (ADR-006)
 * ============================================================ */

const flakyPrCi = rule('flaky-pr-ci')
  .on('workflow_run.completed')
  .when((ctx) =>
    ctx.event.workflow_run.conclusion === 'failure' &&
    ctx.event.workflow_run.pull_requests.length > 0,
  )
  .aggregate({
    window: '1h',
    count: 3,
    key: (ctx) => String(ctx.event.workflow_run.pull_requests[0]?.id ?? 0),
    at: (ctx) => Date.parse(ctx.event.workflow_run.created_at),
  })
  .action('notify-flaky-runs');

const _ruleCheck2: RegisteredRule = flakyPrCi();

/* ============================================================ *
 * Scheduled rule (ADR-007)
 * ============================================================ */

const issueClosedQuiet = rule('issue-closed-quiet')
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
    check: async (ctx): Promise<CheckResult> => {
      void ctx.payload;
      void ctx.scheduledAt;
      return { kind: 'pass' };
    },
  })
  .action('notify-quiet-close');

const _ruleCheck3: RegisteredRule = issueClosedQuiet();

/* ============================================================ *
 * Rule with `.args` + multiple `.action` chain
 * ============================================================ */

const hostilePrComment = rule('hostile-pr-comment')
  .args(z.object({ allowedAuthors: z.array(z.string()) }))
  .on('issue_comment.created')
  .when(
    all(
      (ctx) => !ctx.args.allowedAuthors.includes(ctx.event.comment.user.login),
      use('is_hostile_comment', { minConfidence: 0.8 }),
    ),
  )
  .action('notify-slack')
  .action('open-linear-ticket');

const _ruleCheck4: RegisteredRule = hostilePrComment({ allowedAuthors: ['Marat'] });

/* ============================================================ *
 * Engine wiring (ADR-014)
 * ============================================================ */

declare function makeEngine(opts?: EngineOptions): RuleEngine;
const engine = makeEngine();
// also the ctor form
const _e2: RuleEngine = new RuleEngineCtor();

engine.register({
  integrations: [classifier, slack],
  predicates: [isTeamMember(), touchesPaths(), isHostileComment({ minCommentLength: 100 })],
  actions: [notifySlack({ channel: '#moderation' })],
  aggregatedActions: [notifyFlakyRuns({ channel: '#ci' })],
  scheduledActions: [notifyQuietClose({ channel: '#triage' })],
  rules: [
    infraPrFromOutsider(),
    flakyPrCi(),
    issueClosedQuiet(),
    hostilePrComment({ allowedAuthors: ['Marat'] }),
  ],
});

// Typed event emitter
engine.on('rule.matched', (e) => {
  const _id: string = e.ruleId;
  const _delivery: string = e.deliveryId;
  const _elapsed: number = e.elapsedMs;
});
engine.on('predicate.evaluated', (e) => {
  const _cached: boolean = e.cached;
});

// evaluate() resolves with void on success/skip; rejects on action error.
declare const envelope: EventEnvelope;
const _p: Promise<void> = engine.evaluate(envelope);
void _p;
