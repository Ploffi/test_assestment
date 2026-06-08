export interface LiveGitHubEnv {
  apiUrl: string;
  organization: string;
  repositoryVisibility: 'private' | 'public' | 'internal';
  token: string;
}

export interface GitHubRepo {
  default_branch: string;
  full_name: string;
  name: string;
}

export interface GitHubHook {
  id: number;
}

export interface GitHubIssue {
  html_url: string;
  number: number;
  state: 'open' | 'closed';
  title: string;
}

export interface GitHubPullRequest {
  html_url: string;
  number: number;
}

export interface GitHubRelease {
  html_url: string;
  id: number;
  tag_name: string;
}

export interface GitHubWorkflowRun {
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  html_url: string;
  id: number;
  status: string | null;
}

export interface GitHubWorkflowRunsResponse {
  workflow_runs: GitHubWorkflowRun[];
}

export interface GitHubRef {
  object: { sha: string };
}

export interface GitHubContentFile {
  content?: { sha?: string };
}

export function requiredGitHubEnv(): string[] {
  return ['LIVE_GITHUB_ORG', 'LIVE_GITHUB_TOKEN'];
}

export function readGitHubEnv(): LiveGitHubEnv {
  const missing = requiredGitHubEnv().filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing live GitHub env: ${missing.join(', ')}`);

  return {
    apiUrl: process.env['LIVE_GITHUB_API_URL'] ?? 'https://api.github.com',
    organization: process.env['LIVE_GITHUB_ORG']!,
    repositoryVisibility: readRepositoryVisibility(),
    token: process.env['LIVE_GITHUB_TOKEN']!,
  };
}

export async function createRepository(env: LiveGitHubEnv, name: string): Promise<GitHubRepo> {
  return githubRequest<GitHubRepo>(env, 'POST', `/orgs/${env.organization}/repos`, {
    auto_init: true,
    description: 'Temporary repository created by the Air live GitHub E2E test.',
    has_issues: true,
    name,
    private: env.repositoryVisibility === 'private',
    visibility: env.repositoryVisibility,
  }, [201]);
}

export async function deleteRepository(env: LiveGitHubEnv, repo: string): Promise<void> {
  await githubRequest<void>(env, 'DELETE', `/repos/${env.organization}/${repo}`, undefined, [204, 404]);
}

export async function createWebhook(
  env: LiveGitHubEnv,
  repo: string,
  url: string,
  secret: string,
): Promise<GitHubHook> {
  try {
    return await githubRequest<GitHubHook>(env, 'POST', `/repos/${env.organization}/${repo}/hooks`, {
      active: true,
      config: {
        content_type: 'json',
        insecure_ssl: '0',
        secret,
        url,
      },
      events: ['issues', 'issue_comment', 'pull_request', 'release', 'workflow_run'],
      name: 'web',
    }, [201]);
  } catch (err) {
    if (err instanceof Error && err.message.includes(' 403:')) {
      throw new Error(`${err.message}\nToken is missing repository permission: Webhooks: Read and write.`);
    }
    throw err;
  }
}

export async function deleteWebhook(env: LiveGitHubEnv, repo: string, hookId: number): Promise<void> {
  await githubRequest<void>(env, 'DELETE', `/repos/${env.organization}/${repo}/hooks/${hookId}`, undefined, [204, 404]);
}

export async function createIssue(
  env: LiveGitHubEnv,
  repo: string,
  input: { title: string; body: string },
): Promise<GitHubIssue> {
  return githubRequest<GitHubIssue>(env, 'POST', `/repos/${env.organization}/${repo}/issues`, input, [201]);
}

export async function updateIssueState(
  env: LiveGitHubEnv,
  repo: string,
  issueNumber: number,
  state: 'open' | 'closed',
): Promise<GitHubIssue> {
  return githubRequest<GitHubIssue>(
    env,
    'PATCH',
    `/repos/${env.organization}/${repo}/issues/${issueNumber}`,
    state === 'closed' ? { state, state_reason: 'completed' } : { state },
    [200],
  );
}

export async function createBranch(
  env: LiveGitHubEnv,
  repo: string,
  baseBranch: string,
  branch: string,
): Promise<void> {
  const baseRef = await githubRequest<GitHubRef>(
    env,
    'GET',
    `/repos/${env.organization}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    undefined,
    [200],
  );

  await githubRequest<void>(env, 'POST', `/repos/${env.organization}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  }, [201]);
}

export async function putFile(
  env: LiveGitHubEnv,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  await githubRequest<void>(env, 'PUT', `/repos/${env.organization}/${repo}/contents/${encodePath(path)}`, {
    branch,
    content: Buffer.from(content).toString('base64'),
    message,
  }, [200, 201]);
}

export async function createPullRequest(
  env: LiveGitHubEnv,
  repo: string,
  input: { title: string; head: string; base: string; body?: string },
): Promise<GitHubPullRequest> {
  return githubRequest<GitHubPullRequest>(env, 'POST', `/repos/${env.organization}/${repo}/pulls`, input, [201]);
}

export async function createIssueComment(
  env: LiveGitHubEnv,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await githubRequest<void>(env, 'POST', `/repos/${env.organization}/${repo}/issues/${issueNumber}/comments`, { body }, [201]);
}

export async function createRelease(
  env: LiveGitHubEnv,
  repo: string,
  input: { tagName: string; name: string; body: string; targetCommitish: string },
): Promise<GitHubRelease> {
  return githubRequest<GitHubRelease>(env, 'POST', `/repos/${env.organization}/${repo}/releases`, {
    body: input.body,
    draft: false,
    name: input.name,
    prerelease: false,
    tag_name: input.tagName,
    target_commitish: input.targetCommitish,
  }, [201]);
}

export async function listPullRequestWorkflowRuns(
  env: LiveGitHubEnv,
  repo: string,
  branch: string,
): Promise<GitHubWorkflowRun[]> {
  const result = await githubRequest<GitHubWorkflowRunsResponse>(
    env,
    'GET',
    `/repos/${env.organization}/${repo}/actions/runs?event=pull_request&branch=${encodeURIComponent(branch)}&per_page=20`,
    undefined,
    [200],
  );
  return result.workflow_runs;
}

async function githubRequest<T>(
  env: LiveGitHubEnv,
  method: string,
  path: string,
  body: unknown,
  expectedStatuses: number[],
): Promise<T> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'user-agent': 'air-live-e2e',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `GitHub ${method} ${path} failed with ${response.status}: ${text}${permissionHint(response.status, method, path)}`,
    );
  }

  return (text ? JSON.parse(text) : undefined) as T;
}

function permissionHint(status: number, method: string, path: string): string {
  if (status !== 403) return '';
  if (method === 'POST' && path.includes('/hooks')) {
    return '\nToken is missing repository permission: Webhooks: Read and write.';
  }
  if (path.includes('/contents/.github/workflows/')) {
    return '\nToken is missing repository permissions: Contents: Read and write and Workflows: Read and write.';
  }
  if (path.includes('/contents/') || path.includes('/git/refs')) {
    return '\nToken is missing repository permission: Contents: Read and write.';
  }
  if (path.includes('/pulls')) {
    return '\nToken is missing repository permission: Pull requests: Read and write.';
  }
  if (path.includes('/releases')) {
    return '\nToken is missing repository permission: Contents: Read and write.';
  }
  if (path.includes('/actions/runs')) {
    return '\nToken is missing repository permission: Actions: Read-only.';
  }
  return '';
}

function readRepositoryVisibility(): LiveGitHubEnv['repositoryVisibility'] {
  const value = process.env['LIVE_GITHUB_REPOSITORY_VISIBILITY'] ?? 'private';
  if (value === 'private' || value === 'public' || value === 'internal') return value;
  throw new Error(`LIVE_GITHUB_REPOSITORY_VISIBILITY must be private, public, or internal, got ${value}`);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
