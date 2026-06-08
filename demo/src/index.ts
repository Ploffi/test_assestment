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
});

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
