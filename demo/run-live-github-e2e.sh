#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  echo "[live-e2e] Loading ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
else
  echo "[live-e2e] No ${ENV_FILE}; using current shell environment"
fi

: "${LIVE_GITHUB_TOKEN:?Set LIVE_GITHUB_TOKEN to a GitHub token for the test org}"
: "${NGROK_AUTHTOKEN:?Set NGROK_AUTHTOKEN from https://dashboard.ngrok.com/get-started/your-authtoken}"

export DATABASE_URL="${DATABASE_URL:-postgres://air:air@localhost:15432/air_demo}"
export LIVE_GITHUB_ORG="${LIVE_GITHUB_ORG:-PloffiTestOrg}"
export LIVE_GITHUB_REPOSITORY_VISIBILITY="${LIVE_GITHUB_REPOSITORY_VISIBILITY:-private}"

if [[ ! -d "${REPO_ROOT}/engine/node_modules" ]]; then
  echo "[live-e2e] Engine dependencies are missing; installing with npm ci"
  npm --prefix "${REPO_ROOT}/engine" ci
fi

echo "[live-e2e] Building @air/engine runtime package"
npm --prefix "${REPO_ROOT}/engine" run build

if [[ ! -d "${SCRIPT_DIR}/node_modules/@ngrok/ngrok" ]]; then
  echo "[live-e2e] @ngrok/ngrok is missing; installing demo dependencies with npm ci"
  npm --prefix "${SCRIPT_DIR}" ci
else
  echo "[live-e2e] Demo dependencies already installed"
fi

echo "[live-e2e] Using GitHub org: ${LIVE_GITHUB_ORG}"
echo "[live-e2e] Repository visibility: ${LIVE_GITHUB_REPOSITORY_VISIBILITY}"
echo "[live-e2e] Database URL: ${DATABASE_URL}"
echo "[live-e2e] Starting PostgreSQL via Docker Compose"
docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d --wait postgres

echo "[live-e2e] Running live GitHub E2E"
npm --prefix "${SCRIPT_DIR}" run test:live-github
