import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { DashboardSnapshot } from '../src/dashboard.js';
import { createDemoStore, type DemoNotification } from '../src/rules.js';
import { createApp, type DemoApp } from '../src/server.js';

const secret = 'test-secret';

describe('GitHub webhook demo e2e', () => {
  let demo: DemoApp;
  let baseUrl: string;

  beforeEach(async () => {
    const store = createDemoStore({ coreTeam: ['alice'] });
    demo = createApp({ webhookSecret: secret, store });
    await demo.app.listen({ host: '127.0.0.1', port: 0 });

    const address = demo.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await demo.app.close();
  });

  test('accepts a signed pull_request.opened webhook and records a notification', async () => {
    const response = await sendHook('pull_request', 'delivery-pr-1', {
      action: 'opened',
      repository: { id: 1, full_name: 'air/demo' },
      pull_request: {
        number: 12,
        title: 'Update infra bootstrap',
        html_url: 'https://github.com/air/demo/pull/12',
        base: { ref: 'main' },
        head: { ref: 'mallory/infra-bootstrap' },
        user: { login: 'mallory' },
      },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ignored: false,
      event: 'pull_request.opened',
    });

    const notifications = await listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      deliveryId: 'delivery-pr-1',
      eventName: 'pull_request.opened',
      ruleId: 'infra-pr-from-outsider',
      repository: 'air/demo',
      url: 'https://github.com/air/demo/pull/12',
    });
  });

  test('rejects a webhook with an invalid signature', async () => {
    const rawBody = JSON.stringify({ action: 'created' });
    const response = await fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-bad-signature',
        'x-hub-signature-256': sign(rawBody, 'wrong-secret'),
      },
      body: rawBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'invalid signature' });
    expect(await listNotifications()).toEqual([]);
  });

  test('aggregates three failed workflow_run.completed hooks for the same PR', async () => {
    for (let runId = 1; runId <= 3; runId++) {
      const response = await sendHook('workflow_run', `delivery-ci-${runId}`, {
        action: 'completed',
        repository: { id: 1, full_name: 'air/demo' },
        workflow_run: {
          id: runId,
          html_url: `https://github.com/air/demo/actions/runs/${runId}`,
          conclusion: 'failure',
          head_sha: 'abc123',
          pull_requests: [{ id: 42, number: 7 }],
        },
      });

      expect(response.status).toBe(202);
    }

    const notifications = await listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      deliveryId: 'delivery-ci-3',
      eventName: 'workflow_run.completed',
      ruleId: 'flaky-ci-on-pr',
      aggregateCount: 3,
    });
  });

  test('exposes notifications, logs, and events on the dashboard data endpoint', async () => {
    const response = await sendHook('pull_request', 'delivery-dashboard-1', {
      action: 'opened',
      repository: { id: 1, full_name: 'air/demo' },
      pull_request: {
        number: 21,
        title: 'Infra dashboard check',
        html_url: 'https://github.com/air/demo/pull/21',
        base: { ref: 'main' },
        head: { ref: 'mallory/infra-dashboard' },
        user: { login: 'mallory' },
      },
    });

    expect(response.status).toBe(202);

    const dashboard = await dashboardData();
    expect(dashboard.notifications).toHaveLength(1);
    expect(dashboard.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'POST /github/webhook 202' }),
    ]));
    expect(dashboard.webhookEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deliveryId: 'delivery-dashboard-1',
        engineEvent: 'pull_request.opened',
        outcome: 'accepted',
      }),
    ]));
    expect(dashboard.engineEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'evaluation.completed' }),
    ]));
  });

  async function sendHook(githubEvent: string, deliveryId: string, payload: unknown): Promise<Response> {
    const rawBody = JSON.stringify(payload);
    return fetch(`${baseUrl}/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': githubEvent,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(rawBody, secret),
      },
      body: rawBody,
    });
  }

  async function listNotifications(): Promise<DemoNotification[]> {
    const response = await fetch(`${baseUrl}/demo/notifications`);
    const body = await response.json() as { notifications: DemoNotification[] };
    return body.notifications;
  }

  async function dashboardData(): Promise<DashboardSnapshot> {
    const response = await fetch(`${baseUrl}/demo/dashboard/data`);
    return await response.json() as DashboardSnapshot;
  }
});

function sign(rawBody: string, signingSecret: string): string {
  return `sha256=${createHmac('sha256', signingSecret).update(rawBody).digest('hex')}`;
}
