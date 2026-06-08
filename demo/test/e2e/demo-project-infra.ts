import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import type { DashboardSnapshot } from '../../src/dashboard.js';
import type { DemoNotification } from '../../src/rules.js';

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  logs: string[];
  name: string;
}

export interface DemoProcessOptions {
  classifierUrl?: string;
  databaseUrl: string;
  githubApiUrl: string;
  githubToken: string;
  port: number;
  webhookSecret: string;
}

export interface ClassifierServer {
  close(): Promise<void>;
  url: string;
}

export const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function requiredDemoEnv(): string[] {
  return ['DATABASE_URL'];
}

export function readDatabaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (!value) throw new Error('Missing DATABASE_URL');
  return value;
}

export function startDemoProcess(opts: DemoProcessOptions): ManagedProcess {
  return startProcess('demo', npmCommand(), ['run', 'start'], {
    cwd: demoRoot,
    env: {
      ...process.env,
      DATABASE_URL: opts.databaseUrl,
      DEMO_CLASSIFIER_URL: opts.classifierUrl,
      DEMO_FLAKY_CI_WINDOW: '5m',
      DEMO_ISSUE_CLOSED_QUIET_DEADLINE: '2m',
      DEMO_ISSUE_CLOSED_QUIET_DELAY: '1m',
      GITHUB_API_URL: opts.githubApiUrl,
      GITHUB_TOKEN: opts.githubToken,
      GITHUB_WEBHOOK_SECRET: opts.webhookSecret,
      HOST: '127.0.0.1',
      PORT: String(opts.port),
    },
  });
}

export async function startClassifierServer(): Promise<ClassifierServer> {
  const server = createHttpServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const text = parseClassifierText(raw);
      const responseBody = JSON.stringify(
        text.toLowerCase().includes('[hostile]')
          ? { label: 'hostile', confidence: 0.95 }
          : { label: 'ok', confidence: 0.95 },
      );
      response.writeHead(200, {
        'content-length': Buffer.byteLength(responseBody),
        'content-type': 'application/json',
      });
      response.end(responseBody);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/classify`,
    close: async () => closeHttpServer(server),
  };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  await closeServer(server);
  return address.port;
}

export async function waitForHealth(baseUrl: string, proc: ManagedProcess): Promise<void> {
  await waitFor('demo health', 30_000, 500, async () => {
    if (proc.child.exitCode !== null) {
      throw new Error(`${proc.name} exited early:\n${proc.logs.join('\n')}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
}

export async function truncateDemoTables(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('TRUNCATE demo_notifications, demo_aggregation_entries, demo_scheduled_checks RESTART IDENTITY');
  } finally {
    await pool.end();
  }
}

export async function listNotifications(baseUrl: string): Promise<DemoNotification[]> {
  const response = await fetch(`${baseUrl}/demo/notifications`);
  if (!response.ok) throw new Error(`GET /demo/notifications failed with ${response.status}`);
  const body = await response.json() as { notifications: DemoNotification[] };
  return body.notifications;
}

export async function dashboardData(baseUrl: string): Promise<DashboardSnapshot> {
  const response = await fetch(`${baseUrl}/demo/dashboard/data`);
  if (!response.ok) throw new Error(`GET /demo/dashboard/data failed with ${response.status}`);
  return await response.json() as DashboardSnapshot;
}

export async function stopProcess(proc: ManagedProcess): Promise<void> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;

  const exited = new Promise<boolean>((resolveExit) => {
    proc.child.once('exit', () => resolveExit(true));
  });
  proc.child.kill('SIGTERM');

  if (!(await Promise.race([exited, delay(5_000).then(() => false)]))) {
    proc.child.kill('SIGKILL');
    await exited;
  }
}

export async function waitFor<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }

  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`${label} timed out after ${timeoutMs}ms.${suffix}`);
}

export async function cleanup(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`${label} cleanup failed`, err);
  }
}

export function logStep(message: string): void {
  console.log(`Live GitHub E2E: ${message}`);
}

function startProcess(
  name: string,
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): ManagedProcess {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  const logs: string[] = [];
  const append = (chunk: Buffer) => {
    logs.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return { child, logs, name };
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.close();
  await once(server, 'close');
}

function parseClassifierText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}
