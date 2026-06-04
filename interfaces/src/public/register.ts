/**
 * Register-phase errors (ADR-016).
 *
 * `engine.register(...)` is synchronous and runs two passes over the full
 * batch (dependency-graph + schema). Both passes run; the thrown
 * `RegistrationError` aggregates every issue found, in deterministic order.
 */

export type IssueCode =
  // dependency-graph (pass 1)
  | 'unknown-predicate'
  | 'unknown-action'
  | 'on-mismatch'
  | 'kind-mismatch'
  | 'missing-aggregated-action'
  | 'missing-scheduled-action'
  | 'aggregate-and-schedule'
  | 'duplicate-name'
  // schema (pass 2)
  | 'invalid-args';

export type EntityKind =
  | 'predicate'
  | 'action'
  | 'aggregatedAction'
  | 'scheduledAction'
  | 'rule'
  | 'integration';

export interface RegistrationIssue {
  readonly code: IssueCode;
  readonly entity: { kind: EntityKind; name: string };
  /** Zod path inside args for `invalid-args`; otherwise absent. */
  readonly path?: ReadonlyArray<string | number>;
  readonly message: string;
  /** Counterpart entity for `on-mismatch` / `kind-mismatch`. */
  readonly related?: { kind: EntityKind; name: string };
}

export class RegistrationError extends Error {
  override readonly name = 'RegistrationError';
  readonly issues: ReadonlyArray<RegistrationIssue>;

  constructor(issues: RegistrationIssue[]) {
    super(
      `engine.register() failed with ${issues.length} issue(s): ` +
        issues
          .map(
            (i) =>
              `[${i.code}] ${i.entity.kind} ${i.entity.name}: ${i.message}`,
          )
          .join('; '),
    );
    this.issues = issues;
  }
}

/** Thrown by `engine.evaluate(...)` if called before `register()`. */
export class EngineNotReadyError extends Error {
  override readonly name = 'EngineNotReadyError';
  constructor(message = 'engine.evaluate(...) called before engine.register(...)') {
    super(message);
  }
}
