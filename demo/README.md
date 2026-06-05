# Air Webhook Demo

Minimal Fastify service that accepts signed GitHub webhooks and feeds them into `@air/engine`.

## Run

```sh
cd demo
npm install
GITHUB_WEBHOOK_SECRET=dev-secret npm run dev
```

POST GitHub webhooks to `POST /github/webhook`. The demo also exposes `GET /demo/notifications` so tests and humans can inspect the in-memory action results.

## Scope

The demo keeps everything simple and local:

- Webhook signatures use `X-Hub-Signature-256` when `GITHUB_WEBHOOK_SECRET` is set.
- Demo rules are registered at process start.
- Action results are stored in memory only.
- E2E tests start the HTTP server and send signed webhook requests.

Production concerns such as queueing, retries, durable result persistence, delivery deduplication, telemetry export, and graceful shutdown are called out in code comments but intentionally not implemented here.
