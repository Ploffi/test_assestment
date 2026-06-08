import type {
  EngineEventMap,
  EngineEventName,
  EngineEventPayload,
  RuleEngine,
} from '@air/engine';

import type { DemoNotification } from './rules.js';

export interface DashboardLogEntry {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: unknown;
}

export interface DashboardWebhookEvent {
  id: number;
  at: string;
  deliveryId?: string;
  githubEvent?: string;
  engineEvent?: string;
  outcome: 'accepted' | 'ignored' | 'rejected' | 'failed';
  statusCode: number;
  reason?: string;
  payload?: unknown;
}

export interface DashboardEngineEvent {
  id: number;
  at: string;
  name: EngineEventName;
  payload: unknown;
}

export interface DashboardSnapshot {
  notifications: DemoNotification[];
  logs: DashboardLogEntry[];
  webhookEvents: DashboardWebhookEvent[];
  engineEvents: DashboardEngineEvent[];
}

export interface DashboardRecorder {
  recordLog(input: Omit<DashboardLogEntry, 'id' | 'at'>): void;
  recordWebhookEvent(input: Omit<DashboardWebhookEvent, 'id' | 'at'>): void;
  recordEngineEvent<N extends EngineEventName>(name: N, payload: EngineEventPayload<N>): void;
  logs(): DashboardLogEntry[];
  webhookEvents(): DashboardWebhookEvent[];
  engineEvents(): DashboardEngineEvent[];
}

const engineEventNames = [
  'rule.matched',
  'rule.skipped',
  'predicate.evaluated',
  'external.call',
  'aggregate.appended',
  'scheduled.enqueued',
  'scheduled.checked',
  'evaluation.completed',
  'evaluation.failed',
] as const satisfies readonly EngineEventName[];

export function createDashboardRecorder(): DashboardRecorder {
  const logs: DashboardLogEntry[] = [];
  const webhookEvents: DashboardWebhookEvent[] = [];
  const engineEvents: DashboardEngineEvent[] = [];
  let nextLogId = 1;
  let nextWebhookEventId = 1;
  let nextEngineEventId = 1;

  return {
    recordLog(input) {
      logs.push({ ...input, id: nextLogId++, at: new Date().toISOString() });
    },
    recordWebhookEvent(input) {
      webhookEvents.push({ ...input, id: nextWebhookEventId++, at: new Date().toISOString() });
    },
    recordEngineEvent(name, payload) {
      engineEvents.push({ id: nextEngineEventId++, at: new Date().toISOString(), name, payload: safePayload(payload) });
    },
    logs() {
      return logs.slice();
    },
    webhookEvents() {
      return webhookEvents.slice();
    },
    engineEvents() {
      return engineEvents.slice();
    },
  };
}

export function subscribeDashboardToEngine(engine: RuleEngine, dashboard: DashboardRecorder): void {
  for (const name of engineEventNames) {
    engine.on(name, (payload: EngineEventMap[typeof name]) => {
      dashboard.recordEngineEvent(name, payload);
    });
  }
}

export function renderDashboard(snapshot: DashboardSnapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Air Demo Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
    h1, h2 { margin: 0 0 12px; }
    section { margin: 24px 0; padding: 16px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-width: 600px; }
    .muted { color: #64748b; }
    .links { margin: 8px 0 20px; }
    .links a { margin-right: 12px; }
  </style>
</head>
<body>
  <h1>Air Demo Dashboard</h1>
  <div class="links">
    <a href="/demo/dashboard">Refresh</a>
    <a href="/demo/dashboard/data">JSON data</a>
    <a href="/demo/notifications">Notifications JSON</a>
  </div>

  ${renderNotifications(snapshot.notifications)}
  ${renderWebhookEvents(snapshot.webhookEvents)}
  ${renderEngineEvents(snapshot.engineEvents)}
  ${renderLogs(snapshot.logs)}
</body>
</html>`;
}

function renderNotifications(notifications: DemoNotification[]): string {
  return `<section>
    <h2>Notifications (${notifications.length})</h2>
    ${notifications.length === 0 ? empty() : `<table>
      <thead><tr><th>ID</th><th>Created</th><th>Delivery</th><th>Event</th><th>Rule</th><th>Repository</th><th>Message</th><th>URL</th><th>Count</th></tr></thead>
      <tbody>${notifications.map((n) => `<tr><td>${n.id}</td><td>${escapeHtml(n.createdAt)}</td><td>${escapeHtml(n.deliveryId)}</td><td>${escapeHtml(n.eventName)}</td><td>${escapeHtml(n.ruleId)}</td><td>${escapeHtml(n.repository ?? '')}</td><td>${escapeHtml(n.message)}</td><td>${link(n.url)}</td><td>${n.aggregateCount ?? ''}</td></tr>`).join('')}</tbody>
    </table>`}
  </section>`;
}

function renderWebhookEvents(events: DashboardWebhookEvent[]): string {
  return `<section>
    <h2>Webhook Events (${events.length})</h2>
    ${events.length === 0 ? empty() : `<table>
      <thead><tr><th>ID</th><th>At</th><th>Delivery</th><th>GitHub Event</th><th>Engine Event</th><th>Outcome</th><th>Status</th><th>Reason</th><th>Payload</th></tr></thead>
      <tbody>${events.map((event) => `<tr><td>${event.id}</td><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.deliveryId ?? '')}</td><td>${escapeHtml(event.githubEvent ?? '')}</td><td>${escapeHtml(event.engineEvent ?? '')}</td><td>${escapeHtml(event.outcome)}</td><td>${event.statusCode}</td><td>${escapeHtml(event.reason ?? '')}</td><td>${jsonBlock(event.payload)}</td></tr>`).join('')}</tbody>
    </table>`}
  </section>`;
}

function renderEngineEvents(events: DashboardEngineEvent[]): string {
  return `<section>
    <h2>Engine Events (${events.length})</h2>
    ${events.length === 0 ? empty() : `<table>
      <thead><tr><th>ID</th><th>At</th><th>Name</th><th>Payload</th></tr></thead>
      <tbody>${events.map((event) => `<tr><td>${event.id}</td><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.name)}</td><td>${jsonBlock(event.payload)}</td></tr>`).join('')}</tbody>
    </table>`}
  </section>`;
}

function renderLogs(logs: DashboardLogEntry[]): string {
  return `<section>
    <h2>Logs (${logs.length})</h2>
    ${logs.length === 0 ? empty() : `<table>
      <thead><tr><th>ID</th><th>At</th><th>Level</th><th>Message</th><th>Details</th></tr></thead>
      <tbody>${logs.map((log) => `<tr><td>${log.id}</td><td>${escapeHtml(log.at)}</td><td>${escapeHtml(log.level)}</td><td>${escapeHtml(log.message)}</td><td>${jsonBlock(log.details)}</td></tr>`).join('')}</tbody>
    </table>`}
  </section>`;
}

function empty(): string {
  return '<p class="muted">No records yet.</p>';
}

function link(url: string | undefined): string {
  if (!url) return '';
  return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

function jsonBlock(value: unknown): string {
  if (value === undefined) return '';
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function safePayload(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry instanceof Error ? safePayload(entry) : entry]),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
