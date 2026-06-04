/**
 * `engine.register` contract (ADR-002, ADR-016).
 *
 * Synchronous, full-batch. Throws a structured `RegistrationError` whose
 * `issues` list covers every problem found across both passes (dependency
 * graph + Zod schema), in stable order.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  rule,
  action,
  aggregatedAction,
  use,
} from '../_harness.js';
import {
  isTeamMember,
  touchesPaths,
  notifySlack,
  notifyFlakyRuns,
  notifyQuietClose,
  infraPrFromOutsider,
  flakyPrCi,
  issueClosedQuiet,
} from '../_fixtures.js';
import {
  RegistrationError,
  type RegistrationIssue,
} from '../../public/index.js';

describe('engine.register — success', () => {
  test('registers a complete batch and returns void', () => {
    const engine = createEngine();
    const ret = engine.register({
      predicates: [isTeamMember(), touchesPaths()],
      actions: [notifySlack({ channel: '#moderation' })],
      aggregatedActions: [notifyFlakyRuns({ channel: '#ci' })],
      scheduledActions: [notifyQuietClose({ channel: '#triage' })],
      rules: [infraPrFromOutsider(), flakyPrCi(), issueClosedQuiet()],
    });
    expect(ret).toBeUndefined();
  });

  test('accepts a rules-only batch with no predicates / actions', () => {
    const trivialRule = rule('trivial-rule')
      .on('push')
      .when(() => true)
      .action('notify-slack');

    const engine = createEngine();
    engine.register({
      actions: [notifySlack({ channel: '#general' })],
      rules: [trivialRule()],
    });
  });

  test('re-registering replaces the previous batch wholesale (ADR-016)', () => {
    const engine = createEngine();
    engine.register({
      actions: [notifySlack({ channel: '#a' })],
      rules: [],
    });
    engine.register({
      actions: [notifySlack({ channel: '#b' })],
      rules: [],
    });
    // No assertion shape — the contract is that the second call doesn't throw
    // and that subsequent evaluate() sees only the latest batch (covered in
    // integration/rule-dispatch.test.ts).
  });
});

describe('engine.register — failure: dependency graph (pass 1)', () => {
  test('unknown-predicate when `use(name)` does not resolve', () => {
    const orphan = rule('orphan')
      .on('push')
      .when(use('does_not_exist'))
      .action('notify-slack');

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [notifySlack({ channel: '#x' })],
        rules: [orphan()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    const err = caught as RegistrationError;
    const codes = err.issues.map((i: RegistrationIssue) => i.code);
    expect(codes).toContain('unknown-predicate');
  });

  test('unknown-action when `.action(name)` does not resolve', () => {
    const orphan = rule('orphan')
      .on('push')
      .when(() => true)
      .action('does_not_exist');

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({ rules: [orphan()] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some((i) => i.code === 'unknown-action'),
    ).toBe(true);
  });

  test('on-mismatch when aggregatedAction.on differs from rule.on', () => {
    const wrongOn = rule('wrong-on')
      .on('issues.closed')
      .when(() => true)
      .aggregate({
        window: '1h',
        count: 3,
        key: (ctx) => String(ctx.event.issue.id),
      })
      .action('notify-flaky-runs');

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        aggregatedActions: [notifyFlakyRuns({ channel: '#ci' })],
        rules: [wrongOn()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some((i) => i.code === 'on-mismatch'),
    ).toBe(true);
  });

  test('kind-mismatch when scheduledAction attaches to a non-scheduled rule', () => {
    const plainRule = rule('plain')
      .on('push')
      .when(() => true)
      .action('notify-quiet-close');

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        scheduledActions: [notifyQuietClose({ channel: '#triage' })],
        rules: [plainRule()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some((i) => i.code === 'kind-mismatch'),
    ).toBe(true);
  });

  test('missing-aggregated-action when a rule has `.aggregate(...)` but none attached', () => {
    const bareAggRule = rule('bare-agg')
      .on('push')
      .when(() => true)
      .aggregate({
        window: '1h',
        count: 3,
        key: () => 'k',
      })
      .action('notify-slack'); // plain action, not aggregated

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [notifySlack({ channel: '#x' })],
        rules: [bareAggRule()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some(
        (i) => i.code === 'missing-aggregated-action',
      ),
    ).toBe(true);
  });

  test('missing-scheduled-action when a rule has `.schedule(...)` but none attached', () => {
    const bareSchedRule = rule('bare-sched')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'k',
        transform: () => ({}),
        check: async () => ({ kind: 'pass' }),
      })
      .action('notify-slack'); // plain action, not scheduled

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [notifySlack({ channel: '#x' })],
        rules: [bareSchedRule()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some(
        (i) => i.code === 'missing-scheduled-action',
      ),
    ).toBe(true);
  });

  test('duplicate-name when two entities of the same kind share a name in one batch', () => {
    const dupA = action('dup-action')
      .args(z.object({ x: z.number() }))
      .fn(async () => {});
    const dupB = action('dup-action')
      .args(z.object({ y: z.string() }))
      .fn(async () => {});

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [dupA({ x: 1 }), dupB({ y: 'a' })],
        rules: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some((i) => i.code === 'duplicate-name'),
    ).toBe(true);
  });

  test('duplicate-name when action kinds share a name in one batch', () => {
    const plain = action('same-name').args(z.object({})).fn(async () => {});
    const aggregate = aggregatedAction('same-name')
      .on('push')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(async () => {});

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [plain({})],
        aggregatedActions: [aggregate({})],
        rules: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some((i) => i.code === 'duplicate-name'),
    ).toBe(true);
  });
});

describe('engine.register — failure: schema (pass 2)', () => {
  test('invalid-args when pinned registration args fail Zod', () => {
    const channelAction = action('typed-action')
      .args(z.object({ channel: z.string().startsWith('#') }))
      .fn(async () => {});

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        // missing '#' prefix violates `.startsWith('#')`
        actions: [channelAction({ channel: 'no-hash' })],
        rules: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some(
        (i) =>
          i.code === 'invalid-args' &&
          i.entity.kind === 'action' &&
          i.entity.name === 'typed-action',
      ),
    ).toBe(true);
  });

  test('issue.path points into the args object on invalid-args', () => {
    const a = action('nested-args')
      .args(z.object({ inner: z.object({ port: z.number() }) }))
      .fn(async () => {});

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        // @ts-expect-error: deliberately wrong runtime shape
        actions: [a({ inner: { port: 'not-a-number' } })],
        rules: [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    const issue = (caught as RegistrationError).issues.find(
      (i) => i.code === 'invalid-args',
    );
    expect(issue).toBeDefined();
    expect(issue!.path).toEqual(['inner', 'port']);
  });

  test('rule args are validated as complete because rules have no use-site merge', () => {
    const needsTenant = rule('needs-tenant')
      .args(z.object({ tenant: z.string() }))
      .on('push')
      .when((ctx) => ctx.args.tenant === 'acme')
      .action('notify-slack');

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [notifySlack({ channel: '#x' })],
        rules: [needsTenant()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect(
      (caught as RegistrationError).issues.some(
        (i) => i.code === 'invalid-args' && i.entity.kind === 'rule',
      ),
    ).toBe(true);
  });
});

describe('engine.register — aggregation', () => {
  test('aggregates issues from both passes into one throw', () => {
    const badRule = rule('bad-rule')
      .on('push')
      .when(use('missing_pred'))
      .action('missing_action');

    const channelAction = action('channel-action')
      .args(z.object({ channel: z.string().startsWith('#') }))
      .fn(async () => {});

    const engine = createEngine();
    let caught: unknown;
    try {
      engine.register({
        actions: [channelAction({ channel: 'no-hash' })],
        rules: [badRule()],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistrationError);
    const codes = new Set(
      (caught as RegistrationError).issues.map((i) => i.code),
    );
    // both passes contribute
    expect(codes.has('unknown-predicate')).toBe(true);
    expect(codes.has('unknown-action')).toBe(true);
    expect(codes.has('invalid-args')).toBe(true);
  });

  test('issue list ordering is deterministic across runs (ADR-016)', () => {
    const orphan1 = rule('a-rule').on('push').when(use('missing_a')).action('m_a');
    const orphan2 = rule('z-rule').on('push').when(use('missing_z')).action('m_z');

    const engine = createEngine();
    const collect = () => {
      try {
        engine.register({ rules: [orphan1(), orphan2()] });
        throw new Error('expected throw');
      } catch (e) {
        if (!(e instanceof RegistrationError)) throw e;
        return e.issues.map((i) => `${i.code}:${i.entity.name}`);
      }
    };

    expect(collect()).toEqual(collect());
  });
});
