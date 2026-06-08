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
docker run --rm -p 3300:3300 -e GITHUB_WEBHOOK_SECRET=dev-secret air-demo
```

Or run the app with PostgreSQL via Compose from the repository root:

```sh
docker compose up --build
```

Compose exposes the app on `http://localhost:3300` and PostgreSQL on `localhost:15432`.

POST GitHub webhooks to `POST /github/webhook`. The demo also exposes `GET /demo/notifications` so tests and humans can inspect action results. A primitive read-only dashboard is available at `GET /demo/dashboard`, with raw JSON at `GET /demo/dashboard/data`.

## Scope

The demo keeps everything simple and local:

- Webhook signatures use `X-Hub-Signature-256` when `GITHUB_WEBHOOK_SECRET` is set.
- Demo rules are registered at process start.
- Action results use in-memory storage by default, or PostgreSQL when `DATABASE_URL` is set.
- E2E tests start the HTTP server and send signed webhook requests.

Production concerns such as queueing, retries, delivery deduplication, telemetry export, and production-grade graceful shutdown are called out in code comments but intentionally not implemented here.

## Live GitHub E2E

`npm run test:live-github` launches the demo entrypoint with PostgreSQL, opens an ngrok tunnel to the local demo server, creates a temporary repository in a GitHub organization, creates real issues in that repository, receives real GitHub webhooks through ngrok, and verifies task.md example #3 with a shortened one-minute quiet window.

Required environment:

- `DATABASE_URL`: PostgreSQL URL used by the launched demo.
- `LIVE_GITHUB_ORG`: GitHub organization where the test may create and delete a temporary repository.
- `LIVE_GITHUB_TOKEN`: token authorized for that organization.
- `NGROK_AUTHTOKEN`: ngrok authtoken used to create the temporary public tunnel.
- `LIVE_GITHUB_REPOSITORY_VISIBILITY`: optional, one of `private`, `public`, or `internal`; defaults to `private`.

Use a GitHub App installation token or a fine-grained personal access token whose resource owner is the test organization. The token must be allowed to create repositories in the organization and must have repository permissions for `Administration: Read and write`, `Contents: Read and write`, `Workflows: Read and write`, `Actions: Read-only`, `Pull requests: Read and write`, `Webhooks: Read and write`, `Issues: Read and write`, and `Metadata: Read-only`. Repository administration is required because the test creates and deletes the repository; contents/workflows/pull-request permissions are required for the PR and CI scenarios; actions read permission is used to verify workflow runs before checking notifications; webhook write permission is required because the test creates a temporary repository webhook.

In GitHub Actions, this repository currently sets `LIVE_GITHUB_ORG` to `PloffiTestOrg` in `.github/workflows/ci.yml`. Configure `LIVE_GITHUB_REPOSITORY_VISIBILITY` as an optional repository variable. Configure `LIVE_GITHUB_TOKEN` and `NGROK_AUTHTOKEN` as repository secrets.

To obtain the ngrok token, sign in to the ngrok dashboard and open **Your Authtoken**: <https://dashboard.ngrok.com/get-started/your-authtoken>. You can also manage/create authtokens under **Tunnels -> Authtokens**: <https://dashboard.ngrok.com/tunnels/authtokens>.

The test creates one temporary repository named `air-live-e2e-<id>`, one temporary webhook, pull requests, releases, and issues. It deletes the webhook, closes the issues, and deletes the repository during cleanup. The CI workflow provides PostgreSQL as a service; if the live settings are absent, the Vitest suite is skipped.
