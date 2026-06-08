import { randomUUID } from 'node:crypto';
import type { Listener } from '@ngrok/ngrok';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { DashboardSnapshot, DashboardWebhookEvent } from '../../src/dashboard.js';
import type { DemoNotification } from '../../src/rules.js';
import {
  cleanup,
  dashboardData,
  freePort,
  listNotifications,
  logStep,
  readDatabaseUrl,
  requiredDemoEnv,
  startClassifierServer,
  startDemoProcess,
  stopProcess,
  truncateDemoTables,
  waitFor,
  waitForHealth,
  type ClassifierServer,
  type ManagedProcess,
} from './demo-project-infra.js';
import {
  createBranch,
  createIssue,
  createIssueComment,
  createPullRequest,
  createRelease,
  createRepository,
  createWebhook,
  deleteRepository,
  deleteWebhook,
  listPullRequestWorkflowRuns,
  putFile,
  readGitHubEnv,
  requiredGitHubEnv,
  updateIssueState,
  type GitHubHook,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubRepo,
  type LiveGitHubEnv,
} from './github-infra.js';
import {
  readNgrokAuthtoken,
  requiredTunnelEnv,
  startNgrokTunnel,
} from './tunnel-infra.js';

const missingEnv = [
  ...requiredDemoEnv(),
  ...requiredGitHubEnv(),
  ...requiredTunnelEnv(),
].filter((name) => !process.env[name]);
const describeLive = missingEnv.length === 0 ? describe.sequential : describe.skip;

describeLive(`live task.md scenarios${missingEnv.length ? ` (missing ${missingEnv.join(', ')})` : ''}`, () => {
  const runId = randomUUID().slice(0, 8);
  const webhookSecret = `air-live-${randomUUID()}`;
  let baseUrl = '';
  let classifier: ClassifierServer | undefined;
  let databaseUrl = '';
  let demo: ManagedProcess | undefined;
  let env: LiveGitHubEnv;
  let hook: GitHubHook | undefined;
  let repo: GitHubRepo | undefined;
  let tunnel: Listener | undefined;
  const issues: GitHubIssue[] = [];

  beforeAll(async () => {
    env = readGitHubEnv();
    databaseUrl = readDatabaseUrl();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    logStep('Starting classifier stub and demo process');
    classifier = await startClassifierServer();
    demo = startDemoProcess({
      classifierUrl: classifier.url,
      databaseUrl,
      githubApiUrl: env.apiUrl,
      githubToken: env.token,
      port,
      webhookSecret,
    });
    await waitForHealth(baseUrl, demo);
    await truncateDemoTables(databaseUrl);

    tunnel = await startNgrokTunnel(port, readNgrokAuthtoken());
    const webhookUrl = `${tunnel.url()}/github/webhook`;

    logStep('Creating temporary GitHub repository and webhook');
    repo = await createRepository(env, `air-live-e2e-${runId}`);
    hook = await createWebhook(env, repo.name, webhookUrl, webhookSecret);
  }, 90_000);

  afterAll(async () => {
    logStep('Cleaning up live GitHub resources');
    const repoName = repo?.name;
    const hookId = hook?.id;
    if (repoName !== undefined && hookId !== undefined) {
      await cleanup('delete GitHub webhook', () => deleteWebhook(env, repoName, hookId));
    }
    if (repoName !== undefined) {
      for (const issue of issues) {
        await cleanup(`close GitHub issue #${issue.number}`, () => updateIssueState(env, repoName, issue.number, 'closed'));
      }
      await cleanup(`delete GitHub repository ${env.organization}/${repoName}`, () => deleteRepository(env, repoName));
    }
    if (tunnel) await cleanup('close ngrok tunnel', () => tunnel!.close());
    if (classifier) await cleanup('close classifier stub', () => classifier!.close());
    if (demo) await stopProcess(demo);
  }, 60_000);

  test('task.md #1: PR to main by outsider touching infra/ notifies, docs PR does not', async () => {
    const activeRepo = requireRepo(repo);
    logStep('Scenario #1: creating infra and docs pull requests');

    const infraPr = await createFilePullRequest(activeRepo, 'infra-pr', 'infra/terraform/main.tf', 'resource "x" "y" {}');
    const docsPr = await createFilePullRequest(activeRepo, 'docs-pr', 'docs/readme.md', 'docs only');

    await waitForWebhook((event) => prNumberFromWebhook(event) === infraPr.number && event.engineEvent === 'pull_request.opened');
    await waitForWebhook((event) => prNumberFromWebhook(event) === docsPr.number && event.engineEvent === 'pull_request.opened');

    const notifications = await waitForNotifications('infra PR notification', (items) => {
      const matches = items.filter((item) => item.ruleId === 'infra-pr-from-outsider');
      return matches.length === 1 && matches[0]?.url === infraPr.html_url ? matches : undefined;
    });
    expect(notifications[0]).toMatchObject({ eventName: 'pull_request.opened', url: infraPr.html_url });
  }, 120_000);

  test('task.md #2: same PR with three failing workflow runs notifies once', async () => {
    const activeRepo = requireRepo(repo);
    logStep('Scenario #2: creating failing workflow and triggering three runs');

    await putFile(env, activeRepo.name, activeRepo.default_branch, '.github/workflows/air-live-fail.yml', failingWorkflow(), 'add failing workflow');
    const branch = `${runId}-ci-fail`;
    await createBranch(env, activeRepo.name, activeRepo.default_branch, branch);
    await putFile(env, activeRepo.name, branch, 'ci-trigger-1.txt', 'one', 'trigger failing run 1');
    await createPullRequest(env, activeRepo.name, {
      base: activeRepo.default_branch,
      body: 'Trigger failing workflow runs for Air live E2E.',
      head: branch,
      title: `[air-live-e2e ${runId}] failing workflow`,
    });
    await waitForFailedWorkflowRuns(activeRepo.name, branch, 1);

    await putFile(env, activeRepo.name, branch, 'ci-trigger-2.txt', 'two', 'trigger failing run 2');
    await waitForFailedWorkflowRuns(activeRepo.name, branch, 2);

    await putFile(env, activeRepo.name, branch, 'ci-trigger-3.txt', 'three', 'trigger failing run 3');
    await waitForFailedWorkflowRuns(activeRepo.name, branch, 3);

    const notifications = await waitForNotifications('flaky CI notification', (items) => {
      const matches = items.filter((item) => item.ruleId === 'flaky-ci-on-pr');
      return matches.length === 1 && matches[0]?.aggregateCount === 3 ? matches : undefined;
    }, 300_000);
    expect(notifications[0]).toMatchObject({ eventName: 'workflow_run.completed', aggregateCount: 3 });
  }, 600_000);

  test('task.md #3: issue.closed not reopened within one minute notifies, reopened issue does not', async () => {
    const activeRepo = requireRepo(repo);
    logStep('Scenario #3: closing issues and reopening control issue');

    const stableIssue = await createIssue(env, activeRepo.name, {
      title: `[air-live-e2e ${runId}] stays closed`,
      body: 'This issue should produce one notification.',
    });
    issues.push(stableIssue);
    const reopenedIssue = await createIssue(env, activeRepo.name, {
      title: `[air-live-e2e ${runId}] reopens`,
      body: 'This issue should not notify.',
    });
    issues.push(reopenedIssue);

    await updateIssueState(env, activeRepo.name, stableIssue.number, 'closed');
    await updateIssueState(env, activeRepo.name, reopenedIssue.number, 'closed');
    await updateIssueState(env, activeRepo.name, reopenedIssue.number, 'open');

    await waitForWebhook((event) => issueNumberFromWebhook(event) === stableIssue.number && event.engineEvent === 'issues.closed');
    await waitForWebhook((event) => issueNumberFromWebhook(event) === reopenedIssue.number && event.engineEvent === 'issues.reopened');

    const notifications = await waitForNotifications('issue closed quiet notification', (items) => {
      const falsePositive = items.find((item) => item.ruleId === 'issue-closed-quiet' && item.url === reopenedIssue.html_url);
      if (falsePositive) throw new Error(`False-positive reopened issue notification: ${JSON.stringify(falsePositive)}`);
      const matches = items.filter((item) => item.ruleId === 'issue-closed-quiet');
      return matches.length === 1 && matches[0]?.url === stableIssue.html_url ? matches : undefined;
    }, 130_000);
    expect(notifications[0]).toMatchObject({ eventName: 'issues.closed', url: stableIssue.html_url });
  }, 180_000);

  test('task.md #4: hostile PR comment notifies, normal PR comment does not', async () => {
    const activeRepo = requireRepo(repo);
    logStep('Scenario #4: creating hostile and normal PR comments');

    const pr = await createFilePullRequest(activeRepo, 'comment-pr', 'comments/source.txt', 'comment test');
    await createIssueComment(env, activeRepo.name, pr.number, '[hostile] this is intentionally nasty');
    await createIssueComment(env, activeRepo.name, pr.number, 'normal follow-up');

    await waitForWebhook((event) => issueNumberFromWebhook(event) === pr.number && event.engineEvent === 'issue_comment.created');

    const notifications = await waitForNotifications('hostile comment notification', (items) => {
      const matches = items.filter((item) => item.ruleId === 'hostile-pr-comment');
      return matches.length === 1 && matches[0]?.url?.includes(`/pull/${pr.number}#issuecomment-`) ? matches : undefined;
    });
    expect(notifications[0]).toMatchObject({ eventName: 'issue_comment.created' });
  }, 120_000);

  test('task.md #5: semver breaking release notifies, other releases do not', async () => {
    const activeRepo = requireRepo(repo);
    logStep('Scenario #5: publishing releases');

    const positive = await createRelease(env, activeRepo.name, {
      body: 'Adds the new API. Includes a breaking change.',
      name: 'v1.2.3',
      tagName: 'v1.2.3',
      targetCommitish: activeRepo.default_branch,
    });
    await createRelease(env, activeRepo.name, {
      body: 'breaking change inside a non-semver tag',
      name: `rc-${runId}`,
      tagName: `rc-${runId}`,
      targetCommitish: activeRepo.default_branch,
    });
    await createRelease(env, activeRepo.name, {
      body: 'Patch release. Minor fixes.',
      name: 'v2.0.1',
      tagName: 'v2.0.1',
      targetCommitish: activeRepo.default_branch,
    });

    const notifications = await waitForNotifications('breaking release notification', (items) => {
      const matches = items.filter((item) => item.ruleId === 'breaking-release');
      return matches.length === 1 && matches[0]?.url === positive.html_url ? matches : undefined;
    });
    expect(notifications[0]).toMatchObject({ eventName: 'release.published', url: positive.html_url });
  }, 120_000);

  async function createFilePullRequest(
    activeRepo: GitHubRepo,
    branchPrefix: string,
    path: string,
    content: string,
  ): Promise<GitHubPullRequest> {
    const branch = `${runId}-${branchPrefix}`;
    await createBranch(env, activeRepo.name, activeRepo.default_branch, branch);
    await putFile(env, activeRepo.name, branch, path, content, `add ${path}`);
    return createPullRequest(env, activeRepo.name, {
      base: activeRepo.default_branch,
      body: `Created by Air live E2E ${runId}.`,
      head: branch,
      title: `[air-live-e2e ${runId}] ${branchPrefix}`,
    });
  }

  async function waitForWebhook(
    predicate: (event: DashboardWebhookEvent) => boolean,
    timeoutMs = 90_000,
  ): Promise<DashboardWebhookEvent> {
    return waitFor('expected webhook', timeoutMs, 1_500, async () => {
      const snapshot = await dashboardData(baseUrl);
      return snapshot.webhookEvents.find((event) => event.outcome === 'accepted' && predicate(event));
    });
  }

  async function waitForNotifications<T extends DemoNotification[]>(
    label: string,
    predicate: (items: DemoNotification[]) => T | undefined,
    timeoutMs = 90_000,
  ): Promise<T> {
    return waitFor(label, timeoutMs, 2_000, async () => predicate(await listNotifications(baseUrl)));
  }

  async function waitForFailedWorkflowRuns(
    repoName: string,
    branch: string,
    count: number,
  ) {
    return waitFor(`${count} failed GitHub workflow run(s)`, 180_000, 5_000, async () => {
      const runs = await listPullRequestWorkflowRuns(env, repoName, branch);
      const failed = runs.filter((run) => run.conclusion === 'failure');
      if (failed.length >= count) return failed;

      throw new Error(`workflow runs: ${runs.map((run) => `${run.status}/${run.conclusion}`).join(', ') || 'none'}`);
    });
  }
}, 600_000);

function requireRepo(repo: GitHubRepo | undefined): GitHubRepo {
  if (!repo) throw new Error('test repository was not created');
  return repo;
}

function prNumberFromWebhook(event: DashboardWebhookEvent): number | undefined {
  const payload = event.payload as { pull_request?: { number?: unknown } } | undefined;
  return typeof payload?.pull_request?.number === 'number' ? payload.pull_request.number : undefined;
}

function issueNumberFromWebhook(event: DashboardWebhookEvent): number | undefined {
  const payload = event.payload as { issue?: { number?: unknown } } | undefined;
  return typeof payload?.issue?.number === 'number' ? payload.issue.number : undefined;
}

function failingWorkflow(): string {
  return `name: Air Live E2E Failing Workflow
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  fail:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
`;
}
