# Release Checklist

## Pre-release

1. Confirm schema migrations apply cleanly on a fresh database.
2. Run backend test suite: `pytest -q`
3. Run frontend test suite: `npm test -- --runInBand`
4. Verify key API flows:
   - project/suite/case create
   - API run create and execution
   - Agent eval create and scoring
   - report summary/detail/export

## Observability

1. Confirm every mutating request returns `X-Request-ID`.
2. Confirm audit events are written for mutating routes.
3. Confirm run status counters and evaluator latency metrics are being recorded.
4. Confirm Prometheus target is reachable.

## Infra

1. Validate `docker compose -f infra/docker-compose.yml config`
2. Confirm PostgreSQL, Redis, MinIO, and Prometheus versions match deployment expectations.
3. Confirm secrets are injected through environment or secret manager references only.

## Rollout

1. Apply migrations.
2. Deploy backend.
3. Deploy frontend.
4. Run smoke test on `/api/health`.
5. Execute one API test run and one Agent eval run.

## Post-release

1. Inspect logs for request-id continuity.
2. Review audit events for create/update/delete operations.
3. Confirm report generation and export succeed.
4. Watch error dashboards for 30 minutes after release.
