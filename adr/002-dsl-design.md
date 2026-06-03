# ADR-002: DSL design — code-as-config using `@octokit/webhooks-types`

**Status:** Accepted (supersedes the earlier hybrid-YAML decision dated 2026-05-28)
**Date:** 2026-06-03

## Context

The DSL must express:
1. **Event-shape matching** — narrow incoming webhook payloads by event type, action, repo, branch, labels, author, file paths, etc.
2. **Composition** — AND / OR / NOT over leaf predicates.
3. **External calls** — leaf predicates that hit slow APIs, with the result feeding the boolean tree.
4. **Aggregation** — count / absence over a rolling window keyed by some payload field.

GitHub already publishes precise TypeScript typings for every webhook event in `@octokit/webhooks-types`: a discriminated union over event name, with each variant narrowing to the exact payload shape (PR fields, issue fields, release fields, etc.). Any DSL we invent has to mirror that shape. With YAML + an expression language we would have to *re-encode* the shape and validate it at load time; with TypeScript we get it for free at compile time.

The library is the primary deliverable ([ADR-013](supervisor/013-library-demo-separation.md)) — consumers embed the engine and supply rules at construction. Their build pipeline already compiles TypeScript; the friction of "recompile to change a rule" is the same friction they already pay for any code change in their own codebase.

## Decision

**Code-as-config: rules, predicates, and actions are TypeScript values constructed via a single, uniform builder shape — `entity(name).args(zodSchema).<config>...` — that ends in a callable. Invoking the callable with args produces a registered instance, which `engine.register(...)` consumes.**

The shape, at a glance:

```ts
import type { } from '@octokit/webhooks-types';
import { rule, predicate, action, use, all, not } from '@air/engine';
import { z } from 'zod';

export const infraPrFromOutsider = rule('infra-pr-from-outsider')
  .on('pull_request.opened')                          // narrows ctx.event to PullRequestOpenedEvent
  .when(
    all(
      (ctx) => ctx.event.pull_request.base.ref === 'main',
      not(use('is_team_member', {
        team: 'core',
        login: (ctx) => ctx.event.pull_request.user.login,
      })),
      use('touches_paths', { glob: 'infra/**' }),
    ),
  )
  .action('notify-slack');
```

Key elements:

- **`.on(eventName)`** is a string-literal-typed selector over the union of GitHub webhook event names. After `.on()`, all `ctx.event` accesses inside the rule are narrowed to that variant. No runtime schema validation is needed for event shape — the compiler enforces it.

- **`all` / `any` / `not`** are typed combinators (n-ary AND / OR / negation). Their children are either inline functions `(ctx) => boolean | Promise<boolean>` or `use(name, args)` references to a registered predicate.

- **All callbacks receive a uniform context object**, never a bare event. `ctx` carries `{ event, args, signal, deliveryId, integrations }`: `event` is the narrowed payload, `args` is the validated merged args (see Registration below), `signal` is the per-evaluation `AbortSignal`, `deliveryId` is the webhook delivery id for correlation, and `integrations` exposes registered `IntegrationAdapter`s by name ([ADR-005](005-external-integration-resilience.md)).

- **Predicates** are defined with the same builder shape as rules:

  ```ts
  const isTeamMember = predicate('is_team_member')
    .args(z.object({ team: z.string(), login: z.string() }))
    .fn(async (ctx) => roster.has(ctx.args.team, ctx.args.login));
  ```

  Rules reference them by name with `use(name, args)`. Predicate args that depend on the event can be supplied as functions `(ctx) => value`; the engine resolves them against `ctx` before validating the merged args against the predicate's `argsSchema`. The indirection (rules reference predicates by name rather than importing them) is deliberate: rule files stay free of concrete dependencies, tests can register fakes against the same name, and missing or mistyped names fail at `register()` rather than at evaluate. Adding a new predicate is a localized change — define, register; no engine-core edits.

- **External calls** are predicates whose `.fn` invokes a registered `IntegrationAdapter` (exposed on `ctx.integrations.<name>`); the rule references them via `use(...)` like any other predicate, and the engine handles caching / circuit breaking ([ADR-005](005-external-integration-resilience.md)).

  ```ts
  const isHostileComment = predicate('is_hostile_comment')
    .args(z.object({
      minConfidence: z.number(),
      minCommentLength: z.number().optional(),
    }))
    .fn(async (ctx) => {
      if ((ctx.args.minCommentLength ?? 0) > ctx.event.comment.body.length) return false;
      const { label, confidence } = await ctx.integrations.classifier.classify({
        text: ctx.event.comment.body,
        signal: ctx.signal,
      });
      return label === 'hostile' && confidence >= ctx.args.minConfidence;
    });

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
  ```

- **Aggregation** is a typed builder step on the rule: `.aggregate({ window, count, key })`. `key` is `(ctx) => identifier` (so the key can depend on event *or* rule args) and the engine fires the rule's **aggregated actions** only when `count` matching events fall inside `window` for the same key.

  ```ts
  export const flakyPrCi = rule('flaky-pr-ci')
    .on('workflow_run.completed')
    .when((ctx) =>
      ctx.event.workflow_run.conclusion === 'failure' &&
      ctx.event.workflow_run.pull_requests.length > 0
    )
    .aggregate({
      window: '1h',
      count: 3,
      key: (ctx) => ctx.event.workflow_run.pull_requests[0].id,
    })
    .action('notify-flaky-ci');
  ```

- **Scheduling** is a typed builder step on the rule: `.schedule({ delay, deadline?, key, transform, check })`. The engine stores a per-`key` projection at evaluate time and re-evaluates `check` on a cadence; the rule's **scheduled actions** fire when `check` returns `pass`. Full builder shape, store interface, and check-outcome semantics are in [ADR-007](007-temporal-absence-rules.md).

- **Three action kinds — `action`, `aggregatedAction`, `scheduledAction`.** All three share the unified builder shape (`name → args → fn`), differ in what arrives on `ctx`, and pair with different rule steps. Full builder details for each kind live in the relevant ADRs; the entity-level summary:

  ```ts
  // Plain action — full event on ctx. Pairs with rules that have neither .aggregate nor .schedule.
  const notifySlackAction = action('notify-slack')
    .args(z.object({ channel: z.string() }))
    .fn(async (ctx) => {
      await ctx.integrations.slack.post(ctx.args.channel, render(ctx.event));
    });

  // Aggregated action — declares its own .on(eventName) + .transform(ctx => payload) — see ADR-006.
  // ctx.fn receives the list of stored payloads, not the raw event.
  const notifyFlakyCi = aggregatedAction('notify-flaky-ci')
    .on('workflow_run.completed')
    .args(z.object({ channel: z.string() }))
    .transform((ctx) => ({ runId: ctx.event.workflow_run.id, at: Date.now() }))
    .fn(async (ctx) => { /* ctx.entries, ctx.args, ... */ });

  // Scheduled action — invoked by the scheduler when check returns pass — see ADR-007.
  // Rule owns .schedule(...), action only declares args and the firing function.
  const reactIssueClose = scheduledAction('react-issue-close')
    .args(z.object({ reaction: z.string() }))
    .fn(async (ctx) => { /* ctx.payload, ctx.args, ... */ });
  ```

  Rules reference all three with `.action(name, args?)`. Action args follow the same merge semantics as predicate args (see Registration below). A plain `action` fires whenever `when` returns `true`. An `aggregatedAction` fires only after the rule's `.aggregate(...)` threshold is met; the rule's `.on()` must match the action's `.on()` (checked at `register()`). A `scheduledAction` fires only when the rule's `.schedule(...)` `check` returns `pass`. **A rule cannot have both `.aggregate(...)` and `.schedule(...)`** — `register()` rejects this. Action execution is awaited by `evaluate()` so callers can observe failures; cancellation flows via `ctx.signal`.

- **Validation is the TypeScript compiler.** A misspelled event name, a field path that doesn't exist on the variant, an aggregation key returning a non-comparable value — all caught at `tsc`. Zod is retained only for args validation: each entity's `.args(schema)` provides both the TS type (via `z.infer`) for the `entity({...})` registration call and the runtime check for the merged args before they reach `.fn` / `.when` / `.action`.

- **Registration.** Rules, predicates, and actions are inert *builders* until invoked with args. Invoking the builder produces a registered instance that `engine.register(...)` consumes:

  ```ts
  engine.register({
    predicates: [
      isTeamMember(),                                    // no registration defaults
      touchesPaths(),
      isHostileComment({ minCommentLength: 100 }),       // pinned per deployment
    ],
    actions: [
      notifySlackAction({ channel: '#moderation' }),     // pins the channel for this app
    ],
    aggregatedActions: [
      notifyFlakyCi({ channel: '#ci' }),
    ],
    scheduledActions: [
      reactIssueClose({ reaction: 'closed-not-reopened' }),
    ],
    rules: [
      infraPrFromOutsider(),
      hostilePrComment({ allowedAuthors: ['Marat'] }),
      flakyPrCi(),
    ],
  });
  ```

  **Args precedence: registration > use-site.** When a rule writes `use('is_hostile_comment', { minConfidence: 0.8 })`, the engine merges rule-site args with registration args, and **registration wins on conflict** (defined-only override — keys omitted from the registration call fall through to the rule-site value). This inverts the usual "inner overrides outer" intuition deliberately: it lets the library ship predefined rules — and consumers share rules across projects — while the integrating app pins deployment-specific args without forking the rule. The merged object is then validated against the entity's `argsSchema` and passed as `ctx.args`.

  Rules have no use-site (they are top-level entities), so the registration call supplies the full rule args directly.

  `register()` is **synchronous** and idempotent per `name` (re-registering replaces). It runs two validation passes over the full set of registered entities before returning:

  1. **Dependency-graph check.** Inside the `register()` call the engine has the complete set of predicates, actions, aggregated actions, scheduled actions, and rules in this batch, so it can build the static reference graph: every `use(name, ...)` inside a rule's `.when` tree must resolve to a registered predicate; every `.action(name, ...)` on a rule must resolve to a registered action of *some* kind. References to entities that were declared (a builder exists in the codebase) but **not included in this `register()` call** fail here — "declared but not registered" is the same failure as "name doesn't exist." This pass also enforces the kind-coupling rules: an `aggregatedAction` must attach to a rule with `.aggregate(...)` and the two `.on()` selectors must match; a `scheduledAction` must attach to a rule with `.schedule(...)`; a rule cannot have both `.aggregate(...)` and `.schedule(...)`; a rule with `.aggregate(...)` must attach at least one `aggregatedAction`; same for `.schedule(...)` and `scheduledAction`.
  2. **Registration-args schema check.** Each entity's pinned registration args (e.g., `notifySlackAction({ channel: '#moderation' })`) are validated against that entity's Zod `argsSchema` at register time. Predicate / action args supplied at the `use(...)` / `.action(...)` site can contain `(ctx) => value` callbacks that only resolve per event, so the **merged** args are re-validated at evaluate time ([ADR-004](004-evaluation-model.md)); registration-time validation catches the statically-known portion as early as possible.

  Both passes collect all issues and throw a single aggregate error describing every problem (missing references, schema failures, name collisions across re-registers if explicitly forbidden). Fail fast on the *call*, not on the first issue — surface everything in one pass so callers fix once. After `register()` returns, no event-time evaluation can encounter an unresolved reference or invalid pinned args.

  Builders also support the "declare many, include some" pattern, since they are plain values until invoked:

  ```ts
  import * as allRules from './rules';
  const enabled = Object.values(allRules)
    .filter((r) => flags.isOn(r.name, tenantId))
    .map((r) => r());
  engine.register({ rules: enabled, predicates, actions });
  ```

The engine receives `LoadedRule[]` directly; there is no parser, no expression grammar, no YAML reader.

## Alternatives considered

- **Hybrid YAML + small embedded expression language** (the prior decision). Lets non-engineers author rules and decouples rule changes from rebuilds, but requires us to redefine the payload shape ourselves, lose IDE assistance for field paths, hand-roll a parser (Chevrotain), and maintain two evaluation paths (YAML walker + expression evaluator). The cost is high and the benefit (non-engineer authoring) is hypothetical at this stage. If/when that consumer appears, a YAML front-end can be layered *over* the typed core — the inverse is not as clean.
- **Pure JSON / YAML operator trees** (no expression sub-language). Same shape-redefinition problem; even more verbose for boolean logic. Rejected.
- **CEL or JSONLogic embedded inside a typed wrapper.** Solves the expression-language ergonomics but reintroduces the parallel type system and runtime field-path validation we just eliminated. Rejected.
- **Code-as-config without `@octokit/webhooks-types`** (define our own event interfaces). Forces us to chase GitHub's payload changes by hand. Rejected — the whole point of this approach is to borrow GitHub's types.
- **Distinct builder shapes per entity type** (e.g., `definePredicate({...})` factory, `action(name, fn)` direct, rule builder). Earlier draft of this ADR went this way. Replaced with the unified `entity(name).args(...).<config>...` shape so the three entity types share one mental model and one registration mechanism.
- **Use-site-wins args precedence.** Standard "inner overrides outer" intuition, and what most config systems do. Rejected for predicate/action args because it makes published / shared rules un-customizable — the rule's hard-coded `minConfidence: 0.8` would beat the consumer's deployment override.

## Consequences

**Positive:**
- Field paths, event names, and action discriminators are checked at compile time. A typo in `ctx.event.pull_request.base.ref` fails `tsc`, not production.
- IDE autocomplete on every payload field. Rule authors discover the available shape by typing `ctx.event.`.
- One builder shape for all three entity types — fewer concepts to learn, easier to refactor responsibilities between predicates and actions.
- No parser, no expression grammar, no Zod schema for rule *structure*. Chevrotain drops entirely; Zod is retained only for args validation on the unified `.args(...)` step.
- Registration-wins args precedence makes library-shared rules genuinely portable: a consumer can install a rule and pin its predicates / actions for their environment without forking.
- Refactors of the registry surface as type errors in rule files — broken rules can't ship.
- GitHub schema changes flow in via an `@octokit/webhooks-types` upgrade; we don't maintain a parallel definition.

**Negative:**
- Rule changes require a recompile. Acceptable: consumers are already building TypeScript, and the library ([ADR-013](supervisor/013-library-demo-separation.md)) is intended to be embedded, not operated as a hot-reload rule service.
- Non-engineers can't author rules directly. Mitigation: rule files are small, the surface is narrow enough that a non-engineer can copy-modify with review, and a YAML/JSON front-end can be added later without changing the engine core.
- The demo-server loads rules from a TS module rather than a YAML file. Demo UX is slightly less "drop a file and try it" — the demo will need `tsx` / `esbuild` for ad-hoc rule files.
- Registration-wins precedence is counter-intuitive at first glance — most config systems do the inverse. Mitigation: documented prominently here, surfaced in the explain trace, and the failure mode is "the registered default leaks through visibly," not silent.
- Builder types are non-trivial — each `.args(...)` / `.on(...)` step refines the type of the next step. Will need attention in the engine to keep the inferred types readable in IDE tooltips.
- Downstream ADRs that still reference YAML loading (notably [ADR-013](supervisor/013-library-demo-separation.md) on `loadRules(yaml: string | object[])` and the Chevrotain dependency) are inconsistent with this decision. Tracked as a follow-up; not addressed in this ADR per scope.
