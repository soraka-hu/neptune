# Local Development Runbook

## Prerequisites

- Python 3.12+
- Node.js 25+
- Docker Desktop with `docker compose`

## Start Local Infra

```bash
cd /Users/humeilin/work/workspace/codex_project
docker compose -f infra/docker-compose.yml up -d
```

Services:

- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- MinIO API: `localhost:9000`
- MinIO Console: `localhost:9001`
- Prometheus: `localhost:9090`

## Run Backend

```bash
cd /Users/humeilin/work/workspace/codex_project/backend
export DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:5432/unified_test_eval"
export CASE_GEN_BASE_URL="https://codingplan.alayanew.com/v1"
export CASE_GEN_MODEL="kimi-k2.5"
export CASE_GEN_API_KEY="<your_case_generation_api_key>"
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

## Run Frontend

```bash
cd /Users/humeilin/work/workspace/codex_project/frontend
npm install
npm run dev
```

## Test Commands

Backend:

```bash
cd /Users/humeilin/work/workspace/codex_project/backend
pytest -q
```

Frontend:

```bash
cd /Users/humeilin/work/workspace/codex_project/frontend
npm test -- workbench-routing.test.tsx
```

## Troubleshooting

- If Redis is unavailable, Celery falls back to local stubs for tests but not for full async integration.
- If PostgreSQL is unavailable, the backend defaults to local SQLite for lightweight verification.
- If `host.docker.internal` is not resolvable for Prometheus, update `infra/prometheus/prometheus.yml` to point at your reachable backend host.
