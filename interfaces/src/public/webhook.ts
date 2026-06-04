import type {
  PullRequestOpenedEvent,
  PullRequestClosedEvent,
  PullRequestSynchronizeEvent,
  PullRequestReopenedEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReviewSubmittedEvent,
  IssuesOpenedEvent,
  IssuesClosedEvent,
  IssuesReopenedEvent,
  IssuesEditedEvent,
  IssueCommentCreatedEvent,
  IssueCommentEditedEvent,
  WorkflowRunCompletedEvent,
  WorkflowRunRequestedEvent,
  CheckRunCompletedEvent,
  PushEvent,
  ReleasePublishedEvent,
  ReleaseEditedEvent,
} from '@octokit/webhooks-types';

/**
 * Map of dotted `<event>.<action>` names to their narrowed payload type.
 *
 * Consumers can extend through TypeScript declaration merging:
 *
 *   declare module '@air/interfaces' {
 *     interface EventPayloadMap {
 *       'discussion.created': DiscussionCreatedEvent;
 *     }
 *   }
 *
 * This map is the source of truth for `.on(eventName)` narrowing across the
 * engine (predicates, actions, aggregated actions, rules — see ADR-002 / ADR-016).
 */
export interface EventPayloadMap {
  'pull_request.opened': PullRequestOpenedEvent;
  'pull_request.closed': PullRequestClosedEvent;
  'pull_request.synchronize': PullRequestSynchronizeEvent;
  'pull_request.reopened': PullRequestReopenedEvent;
  'pull_request.ready_for_review': PullRequestReadyForReviewEvent;
  'pull_request_review.submitted': PullRequestReviewSubmittedEvent;

  'issues.opened': IssuesOpenedEvent;
  'issues.closed': IssuesClosedEvent;
  'issues.reopened': IssuesReopenedEvent;
  'issues.edited': IssuesEditedEvent;

  'issue_comment.created': IssueCommentCreatedEvent;
  'issue_comment.edited': IssueCommentEditedEvent;

  'workflow_run.completed': WorkflowRunCompletedEvent;
  'workflow_run.requested': WorkflowRunRequestedEvent;

  'check_run.completed': CheckRunCompletedEvent;

  'push': PushEvent;

  'release.published': ReleasePublishedEvent;
  'release.edited': ReleaseEditedEvent;
}

/** Union of all dotted webhook event names the engine recognizes. */
export type WebhookEventName = keyof EventPayloadMap;

/** Narrowed payload for one event name — what `.on(N)` exposes as `ctx.event`. */
export type PayloadFor<N extends WebhookEventName> = EventPayloadMap[N];

/** Union of every payload type (used where no `.on(...)` has narrowed yet). */
export type AnyEventPayload = EventPayloadMap[WebhookEventName];

/**
 * Envelope the engine receives in `engine.evaluate(envelope)`. Mirrors the
 * shape produced by `@octokit/webhooks` adapters and lets the engine route
 * by name without inspecting payload structure.
 */
export interface EventEnvelope<N extends WebhookEventName = WebhookEventName> {
  name: N;
  payload: PayloadFor<N>;
  /** `X-GitHub-Delivery` UUID; required for correlation (ADR-011, ADR-016). */
  deliveryId: string;
}
