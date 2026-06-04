/**
 * Acceptance suite — covers every example rule explicitly stated in
 * `task.md`, plus the AND / OR / NOT composition requirement.
 *
 * Each example uses a single recording action (`vi.fn`) as the simplest
 * possible "did the rule fire?" probe, then asserts:
 *   - positive envelope → action invoked exactly once
 *   - negative envelope (one premise flipped) → action NOT invoked
 *
 * Rules are defined inline in each test so the file reads as a spec: one
 * `describe` per task.md bullet, the rule definition next to its
 * verification.
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  createInMemoryAggregationStore,
  createInMemoryScheduledStore,
  createManualClock,
  fakeEnvelope,
  rule,
  predicate,
  action,
  integration,
  scheduledAction,
  aggregatedAction,
  all,
  any,
  not,
  use,
} from '../_harness.js';
import type { CheckResult } from '../../public/index.js';

/* ============================================================ *
 * task.md line 17:
 *   "Notify when a PR targeting main is opened by someone outside
 *    the core-team and touches files under infra/."
 * ============================================================ */

describe('task.md #1 — PR opened, main, non-core, touches infra/', () => {
  function build() {
    const recorded = vi.fn(async () => {});
    const recordAction = action('record')
      .args(z.object({}))
      .fn(recorded);

    const isTeamMember = predicate('is_team_member')
      .args(z.object({ team: z.string(), login: z.string() }))
      .fn(async (ctx) => ctx.args.team === 'core' && ctx.args.login === 'alice');

    const touchesPaths = predicate('touches_paths')
      .args(z.object({ glob: z.string() }))
      .fn(async (ctx) => {
        const prefix = ctx.args.glob.replace(/\*\*$/, '');
        const files = ((ctx.event as any).pull_request.files ?? []) as Array<{ filename: string }>;
        return files.some((file) => file.filename.startsWith(prefix));
      });

    const r = rule('notify-infra-outsider')
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
      .action('record');

    const engine = createEngine();
    engine.register({
      predicates: [isTeamMember(), touchesPaths()],
      actions: [recordAction({})],
      rules: [r()],
    });
    return { engine, recorded };
  }

  test('positive — main branch, non-core author, infra/ paths → fires', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('pull_request.opened', {
        pull_request: {
          base: { ref: 'main' },
          user: { login: 'mallory' }, // not 'alice'
          files: [{ filename: 'infra/terraform/main.tf' }],
        },
      } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  test('negative — author is core-team → does NOT fire', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('pull_request.opened', {
        pull_request: {
          base: { ref: 'main' },
          user: { login: 'alice' }, // core team
          files: [{ filename: 'infra/terraform/main.tf' }],
        },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });

  test('negative — base branch is not main → does NOT fire', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('pull_request.opened', {
        pull_request: {
          base: { ref: 'develop' },
          user: { login: 'mallory' },
          files: [{ filename: 'infra/terraform/main.tf' }],
        },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });

  test('negative — main branch outsider but no infra/ paths → does NOT fire', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('pull_request.opened', {
        pull_request: {
          base: { ref: 'main' },
          user: { login: 'mallory' },
          files: [{ filename: 'docs/readme.md' }],
        },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });
});

/* ============================================================ *
 * task.md line 18:
 *   "Fire only when the same PR receives 3 failing CI runs
 *    within an hour."
 * ============================================================ */

describe('task.md #2 — 3 failing CI runs within 1h on same PR', () => {
  function build() {
    const recorded = vi.fn(async () => {});
    const recordAction = aggregatedAction('record')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(recorded);

    const r = rule('flaky-pr-ci')
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
      .action('record');

    const engine = createEngine({
      aggregationStore: createInMemoryAggregationStore(),
    });
    engine.register({ aggregatedActions: [recordAction({})], rules: [r()] });
    return { engine, recorded };
  }

  test('positive — three failing runs for the same PR fires on the third', async () => {
    const { engine, recorded } = build();

    const failingForPr = (prId: number) =>
      fakeEnvelope('workflow_run.completed', {
        workflow_run: {
          conclusion: 'failure',
          pull_requests: [{ id: prId }],
        },
      } as any);

    await engine.evaluate(failingForPr(42));
    await engine.evaluate(failingForPr(42));
    expect(recorded).not.toHaveBeenCalled(); // below threshold

    await engine.evaluate(failingForPr(42));
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  test('negative — runs across different PRs do not aggregate', async () => {
    const { engine, recorded } = build();

    for (const prId of [10, 11, 12]) {
      await engine.evaluate(
        fakeEnvelope('workflow_run.completed', {
          workflow_run: {
            conclusion: 'failure',
            pull_requests: [{ id: prId }],
          },
        } as any),
      );
    }
    expect(recorded).not.toHaveBeenCalled();
  });

  test('negative — successful runs are filtered by .when before aggregating', async () => {
    const { engine, recorded } = build();

    for (let i = 0; i < 5; i++) {
      await engine.evaluate(
        fakeEnvelope('workflow_run.completed', {
          workflow_run: {
            conclusion: 'success',
            pull_requests: [{ id: 42 }],
          },
        } as any),
      );
    }
    expect(recorded).not.toHaveBeenCalled();
  });

  test('negative — two failures in 1h, third after window expires → does NOT fire', async () => {
    // Rolling-window semantics: the first event ages out of the bucket
    // before the third arrives, so only 2 entries lie in `[now − 1h, now]`
    // at evaluation time of the third event.
    const recorded = vi.fn(async () => {});
    const recordAction = aggregatedAction('record')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(recorded);

    const r = rule('flaky-pr-ci-windowed')
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
      .action('record');

    const clock = createManualClock(0);
    const engine = createEngine({
      aggregationStore: createInMemoryAggregationStore({ clock }),
      clock,
    });
    engine.register({ aggregatedActions: [recordAction({})], rules: [r()] });

    const failingForPr = (prId: number) =>
      fakeEnvelope('workflow_run.completed', {
        workflow_run: {
          conclusion: 'failure',
          pull_requests: [{ id: prId }],
        },
      } as any);

    // t = 0: first failure
    await engine.evaluate(failingForPr(42));

    // t = 10m: second failure (both still in the 1h window — count = 2)
    clock.advance(10 * 60_000);
    await engine.evaluate(failingForPr(42));

    // t = 70m: third failure. The first event (t=0) is now > 1h old and
    // falls outside `[now − 1h, now] = [10m, 70m]`. Bucket count is 2,
    // not 3 — threshold not met, action stays silent.
    clock.advance(60 * 60_000);
    await engine.evaluate(failingForPr(42));

    expect(recorded).not.toHaveBeenCalled();
  });
});

/* ============================================================ *
 * task.md line 19:
 *   "React an issue.closed event if the issue was not reopened
 *    in the last 5 minutes."
 *
 * Modeled as a *scheduled* rule per ADR-007: enqueue on .closed,
 * defer the decision 5m, then check (negative-absence semantics).
 * ============================================================ */

describe('task.md #3 — issue.closed if not reopened in 5m', () => {
  function build() {
    const recorded = vi.fn(async () => {});
    const reopenedIssueIds = new Set<number>();
    const recordAction = scheduledAction('record')
      .args(z.object({}))
      .fn(recorded);

    const r = rule('issue-closed-quiet')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: (ctx) => String(ctx.event.issue.id),
        transform: (ctx) => ({ issueId: ctx.event.issue.id }),
        check: async (ctx): Promise<CheckResult> => {
          const issueId = (ctx.payload as { issueId: number }).issueId;
          return reopenedIssueIds.has(issueId) ? { kind: 'skip' } : { kind: 'pass' };
        },
      })
      .action('record');

    const clock = createManualClock(0);
    const engine = createEngine({
      scheduledStore: createInMemoryScheduledStore(),
      clock,
    });
    engine.register({ scheduledActions: [recordAction({})], rules: [r()] });
    engine.start();
    return { engine, recorded, clock, reopenedIssueIds };
  }

  test('positive — issue stayed closed for 5m → reaction fires', async () => {
    const { engine, recorded, clock } = build();
    await engine.evaluate(
      fakeEnvelope('issues.closed', { issue: { id: 1 } } as any),
    );
    // Advance past delay + one scheduler tick.
    clock.advance(5 * 60_000 + 11_000);
    await new Promise((r) => setImmediate(r));
    expect(recorded).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  test('negative — issue was reopened in the window → reaction does NOT fire', async () => {
    const { engine, recorded, clock, reopenedIssueIds } = build();
    await engine.evaluate(
      fakeEnvelope('issues.closed', { issue: { id: 1 } } as any),
    );
    reopenedIssueIds.add(1);
    clock.advance(5 * 60_000 + 11_000);
    await new Promise((r) => setImmediate(r));
    expect(recorded).not.toHaveBeenCalled();
    await engine.stop();
  });

  test('negative — checked too early (before delay) → not yet fired', async () => {
    const { engine, recorded, clock } = build();
    await engine.evaluate(
      fakeEnvelope('issues.closed', { issue: { id: 1 } } as any),
    );
    clock.advance(60_000); // 1m — well before 5m
    await new Promise((r) => setImmediate(r));
    expect(recorded).not.toHaveBeenCalled();
    await engine.stop();
  });
});

/* ============================================================ *
 * task.md line 20:
 *   "Notify when a PR comment is flagged as hostile by an
 *    external classification API."
 *
 * Demonstrates the external-integration capability: the predicate's
 * .fn calls ctx.integrations.classifier.classify — slow / fallible
 * by definition, handled per ADR-005.
 * ============================================================ */

describe('task.md #4 — PR comment flagged hostile by classifier', () => {
  function build(label: 'hostile' | 'ok') {
    const recorded = vi.fn(async () => {});
    const recordAction = action('record')
      .args(z.object({}))
      .fn(recorded);

    const classifier = integration('classifier')
      .cache({ ttl: '24h', max: 10_000 })
      .breaker({ errorThresholdPct: 50, resetMs: 30_000 })
      .concurrency(10)
      .retry({ attempts: 3, backoffMs: 200, jitter: true })
      .methods({
        classify: async (_i: {
          text: string;
          signal?: AbortSignal;
        }): Promise<{ label: string; confidence: number }> => {
          return { label, confidence: 0.95 };
        },
      });

    const isHostileComment = predicate('is_hostile_comment')
      .args(z.object({ minConfidence: z.number() }))
      .fn(async (ctx) => {
        // Predicates are event-variant-agnostic per ADR-016; narrow inside .fn.
        const event = ctx.event as { comment: { body: string } };
        const r = await ctx.integrations['classifier']?.['classify']({
          text: event.comment.body,
          signal: ctx.signal,
        });
        return r?.label === 'hostile' && r.confidence >= ctx.args.minConfidence;
      });

    const r = rule('hostile-pr-comment')
      .on('issue_comment.created')
      .when(
        all(
          (ctx) => Boolean((ctx.event.issue as any).pull_request),
          use('is_hostile_comment', { minConfidence: 0.8 }),
        ),
      )
      .action('record');

    const engine = createEngine();
    engine.register({
      integrations: [classifier],
      predicates: [isHostileComment()],
      actions: [recordAction({})],
      rules: [r()],
    });
    return { engine, recorded };
  }

  test('positive — classifier returns hostile → fires', async () => {
    const { engine, recorded } = build('hostile');
    await engine.evaluate(
      fakeEnvelope('issue_comment.created', {
        issue: { pull_request: { url: 'https://api.github.com/pulls/1' } },
        comment: { body: 'something nasty', user: { login: 'mallory' } },
      } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  test('negative — classifier returns ok → does NOT fire', async () => {
    const { engine, recorded } = build('ok');
    await engine.evaluate(
      fakeEnvelope('issue_comment.created', {
        issue: { pull_request: { url: 'https://api.github.com/pulls/1' } },
        comment: { body: 'hello there', user: { login: 'alice' } },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });

  test('negative — hostile issue comment that is not on a PR → does NOT fire', async () => {
    const { engine, recorded } = build('hostile');
    await engine.evaluate(
      fakeEnvelope('issue_comment.created', {
        issue: {},
        comment: { body: 'something nasty', user: { login: 'mallory' } },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });
});

/* ============================================================ *
 * task.md line 21:
 *   "When a release is published, fan out only if the tag matches
 *    v*.*.* and the release notes mention 'breaking change'."
 * ============================================================ */

describe('task.md #5 — release.published + semver tag + "breaking change"', () => {
  function build() {
    const recorded = vi.fn(async () => {});
    const recordAction = action('record')
      .args(z.object({}))
      .fn(recorded);

    const tagMatches = predicate('tag_matches_semver')
      .args(z.object({ pattern: z.string() }))
      .fn(async (ctx) => {
        // Translate the simple glob 'v*.*.*' into a regex.
        const regex = new RegExp(
          '^' + ctx.args.pattern.replace(/\./g, '\\.').replace(/\*/g, '\\d+') + '$',
        );
        // Predicates are event-variant-agnostic per ADR-016; narrow inside .fn.
        const event = ctx.event as { release: { tag_name: string } };
        return regex.test(event.release.tag_name);
      });

    const bodyContains = predicate('body_contains')
      .args(z.object({ needle: z.string() }))
      .fn(async (ctx) => {
        const event = ctx.event as { release: { body?: string } };
        return (event.release.body ?? '').includes(ctx.args.needle);
      });

    const r = rule('breaking-release')
      .on('release.published')
      .when(
        all(
          use('tag_matches_semver', { pattern: 'v*.*.*' }),
          use('body_contains', { needle: 'breaking change' }),
        ),
      )
      .action('record');

    const engine = createEngine();
    engine.register({
      predicates: [tagMatches(), bodyContains()],
      actions: [recordAction({})],
      rules: [r()],
    });
    return { engine, recorded };
  }

  test('positive — v1.2.3 tag + "breaking change" in notes → fires', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('release.published', {
        release: {
          tag_name: 'v1.2.3',
          body: 'Adds X. Note: breaking change in API.',
        },
      } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  test('negative — non-semver tag → does NOT fire', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('release.published', {
        release: {
          tag_name: 'rc-2024-05',
          body: 'breaking change inside',
        },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });

  test('negative — semver tag but no "breaking change" mention → does NOT fire', async () => {
    const { engine, recorded } = build();
    await engine.evaluate(
      fakeEnvelope('release.published', {
        release: {
          tag_name: 'v2.0.1',
          body: 'Patch release. Minor fixes.',
        },
      } as any),
    );
    expect(recorded).not.toHaveBeenCalled();
  });
});

/* ============================================================ *
 * task.md "Compose conditions — AND / OR / NOT, grouping, negation."
 *
 * The acceptance suite uses `all` and `not` in the rules above. The
 * `any` (OR) combinator is exercised here with a small standalone
 * rule so the DSL's full boolean surface is covered.
 * ============================================================ */

describe('DSL composition — OR (any) + grouping + negation', () => {
  test('any(...) fires if at least one branch is true', async () => {
    const recorded = vi.fn(async () => {});
    const rec = action('record')
      .args(z.object({}))
      .fn(recorded);

    const r = rule('any-fires')
      .on('issues.opened')
      .when(
        any(
          (ctx) => ctx.event.issue.title.includes('urgent'),
          (ctx) => ctx.event.issue.title.includes('p0'),
        ),
      )
      .action('record');

    const engine = createEngine();
    engine.register({ actions: [rec({})], rules: [r()] });

    await engine.evaluate(
      fakeEnvelope('issues.opened', { issue: { title: 'p0 — outage' } } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);

    await engine.evaluate(
      fakeEnvelope('issues.opened', { issue: { title: 'normal task' } } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1); // unchanged
  });

  test('nested grouping — all(any(...), not(...)) evaluates with proper precedence', async () => {
    const recorded = vi.fn(async () => {});
    const rec = action('record')
      .args(z.object({}))
      .fn(recorded);

    const r = rule('grouped')
      .on('issues.opened')
      .when(
        all(
          any(
            (ctx) => ctx.event.issue.title.includes('bug'),
            (ctx) => ctx.event.issue.title.includes('regression'),
          ),
          not((ctx) => ctx.event.issue.title.includes('wontfix')),
        ),
      )
      .action('record');

    const engine = createEngine();
    engine.register({ actions: [rec({})], rules: [r()] });

    // bug AND not wontfix → fires
    await engine.evaluate(
      fakeEnvelope('issues.opened', { issue: { title: 'bug in flow' } } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);

    // regression AND wontfix → does not fire (negation kills it)
    await engine.evaluate(
      fakeEnvelope('issues.opened', {
        issue: { title: 'regression — wontfix' },
      } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);

    // neither bug nor regression → does not fire
    await engine.evaluate(
      fakeEnvelope('issues.opened', {
        issue: { title: 'feature request' },
      } as any),
    );
    expect(recorded).toHaveBeenCalledTimes(1);
  });
});
