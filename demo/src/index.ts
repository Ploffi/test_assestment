import { createApp } from './server.js';
import { createPostgresDemoStorage } from './postgres-storage.js';

const port = Number(process.env.PORT ?? 3300);
const host = process.env.HOST ?? '0.0.0.0';
const storage = process.env.DATABASE_URL
  ? createPostgresDemoStorage({ connectionString: process.env.DATABASE_URL })
  : undefined;

await storage?.init();

const { app, engine } = createApp({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  ...(storage
    ? {
        store: storage,
        aggregationStore: storage.aggregationStore,
        scheduledStore: storage.scheduledStore,
      }
    : {}),
  githubApiUrl: process.env.GITHUB_API_URL,
  githubToken: process.env.GITHUB_TOKEN,
  classifierUrl: process.env.DEMO_CLASSIFIER_URL,
  flakyCiWindow: process.env.DEMO_FLAKY_CI_WINDOW,
  issueClosedQuietDelay: process.env.DEMO_ISSUE_CLOSED_QUIET_DELAY,
  issueClosedQuietDeadline: process.env.DEMO_ISSUE_CLOSED_QUIET_DEADLINE,
});

engine.start();

app.addHook('onClose', async () => {
  await engine.stop();
  await storage?.close();
});

await app.listen({ host, port });

console.log(`Air demo webhook service listening on http://${host}:${port}`);

async function shutdown(): Promise<void> {
  try {
    await app.close();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
