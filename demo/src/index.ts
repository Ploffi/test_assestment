import { createApp } from './server.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const { app } = createApp({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
});

await app.listen({ host, port });

// Demo only: production should wire graceful SIGTERM/SIGINT shutdown that stops
// accepting requests, drains in-flight evaluations, and closes persistent stores.
console.log(`Air demo webhook service listening on http://${host}:${port}`);
