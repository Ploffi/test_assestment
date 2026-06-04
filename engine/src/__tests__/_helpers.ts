import type {
  EventEnvelope,
  ManualClock,
  Timer,
  WebhookEventName,
} from '../public/index.js';

interface PendingTimer {
  readonly id: number;
  runAt: number;
  readonly cb: () => void;
  cancelled: boolean;
}

export function createManualClock(initial: number = 0): ManualClock {
  let current = initial;
  let nextId = 1;
  const pending: PendingTimer[] = [];

  const sweepUpTo = (target: number): void => {
    while (true) {
      pending.sort((a, b) => a.runAt - b.runAt || a.id - b.id);
      const head = pending[0];
      if (!head) break;
      if (head.cancelled) {
        pending.shift();
        continue;
      }
      if (head.runAt > target) break;
      pending.shift();
      current = head.runAt;
      head.cb();
    }
    current = target;
  };

  return {
    now(): number {
      return current;
    },
    setTimeout(cb: () => void, delayMs: number): Timer {
      const timer: PendingTimer = {
        id: nextId++,
        runAt: current + delayMs,
        cb,
        cancelled: false,
      };
      pending.push(timer);
      return {
        cancel(): void {
          timer.cancelled = true;
        },
      };
    },
    set(timeMs: number): void {
      current = timeMs;
    },
    advance(deltaMs: number): void {
      sweepUpTo(current + deltaMs);
    },
  };
}

function skeletonPayload(name: WebhookEventName): any {
  switch (name) {
    case 'workflow_run.completed':
    case 'workflow_run.requested':
      return {
        action: name.split('.')[1],
        workflow_run: {
          id: 0,
          html_url: '',
          conclusion: 'success',
          head_sha: '',
          pull_requests: [],
        },
      };
    case 'pull_request.opened':
    case 'pull_request.closed':
    case 'pull_request.reopened':
    case 'pull_request.synchronize':
    case 'pull_request.ready_for_review':
      return {
        action: name.split('.')[1],
        pull_request: {
          base: { ref: '' },
          user: { login: '' },
        },
      };
    case 'pull_request_review.submitted':
      return { action: 'submitted', review: {} };
    case 'issues.opened':
    case 'issues.closed':
    case 'issues.reopened':
    case 'issues.edited':
      return {
        action: name.split('.')[1],
        issue: {
          id: 0,
          html_url: '',
          title: '',
          state_reason: null,
        },
      };
    case 'issue_comment.created':
    case 'issue_comment.edited':
      return {
        action: name.split('.')[1],
        issue: { id: 0 },
        comment: { body: '', user: { login: '' } },
      };
    case 'check_run.completed':
      return { action: 'completed', check_run: {} };
    case 'release.published':
    case 'release.edited':
      return {
        action: name.split('.')[1],
        release: { tag_name: '', body: '' },
      };
    case 'push':
      return {};
    default:
      return {};
  }
}

function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  const out: Record<string, any> = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(base?.[k], override[k]);
  }
  return out;
}

export function fakeEnvelope<N extends WebhookEventName>(
  name: N,
  payload?: any,
  deliveryId?: string,
): EventEnvelope<N> {
  const merged = deepMerge(skeletonPayload(name), payload ?? {});
  return {
    name,
    payload: merged as any,
    deliveryId: deliveryId ?? `delivery-${Math.random().toString(36).slice(2, 10)}`,
  };
}
