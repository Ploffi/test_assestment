# Air Webhook Demo

Minimal Fastify service that accepts signed GitHub webhooks and feeds them into `@air/engine`.

## Run

```sh
cd demo
npm install
GITHUB_WEBHOOK_SECRET=dev-secret npm run dev
```

Or run it with Docker from the repository root:

```sh
docker build -f demo/Dockerfile -t air-demo .
docker run --rm -p 3000:3000 -e GITHUB_WEBHOOK_SECRET=dev-secret air-demo
```

Or run the app with PostgreSQL via Compose from the repository root:

```sh
docker compose up --build
```

POST GitHub webhooks to `POST /github/webhook`. The demo also exposes `GET /demo/notifications` so tests and humans can inspect action results.

## Scope

The demo keeps everything simple and local:

- Webhook signatures use `X-Hub-Signature-256` when `GITHUB_WEBHOOK_SECRET` is set.
- Demo rules are registered at process start.
- Action results use in-memory storage by default, or PostgreSQL when `DATABASE_URL` is set.
- E2E tests start the HTTP server and send signed webhook requests.

Production concerns such as queueing, retries, delivery deduplication, telemetry export, and production-grade graceful shutdown are called out in code comments but intentionally not implemented here.
