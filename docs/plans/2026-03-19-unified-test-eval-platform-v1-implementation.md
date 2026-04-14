# Unified Test & Eval Platform v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build v1 of the unified API testing + Agent evaluation platform with traceability-first guarantees, single-tenant isolation by `project_id`, and model access only through a unified model gateway.

**Architecture:** We implement a layered backend (`api -> application -> domain -> infrastructure`) with async execution via Redis + Celery, pytest-based execution adapters, pluggable evaluators, and report generation over run artifacts. DB is the source of truth; YAML is rendered as temporary execution view. Frontend delivers two key workbenches (API Test, Agent Eval) plus asset/rule/run/report centers.

**Tech Stack:** FastAPI, SQLAlchemy 2.x, Alembic, Pydantic, PostgreSQL, Redis, Celery, pytest, React, Ant Design, Prometheus/Grafana, Sentry.

---

## Implementation Notes

- I'm using the writing-plans skill to create the implementation plan.
- Execute tasks in order; do not skip failing-test steps.
- Use @brainstorming output and the approved design doc as the contract:
  - `docs/plans/2026-03-19-unified-test-eval-platform-design.md`
- Required v1 constraints:
  - Single-tenant
  - Unified model gateway only
  - Traceability first (no one-click replay in v1)
  - `case_item` write requires JSON Schema validation

### Task 1: Bootstrap Backend Skeleton

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/main.py`
- Create: `backend/app/api/health_api.py`
- Create: `backend/tests/api/test_health_api.py`

**Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from app.main import app

def test_health_check():
    client = TestClient(app)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/api/test_health_api.py::test_health_check -v`  
Expected: FAIL with import/module errors.

**Step 3: Write minimal implementation**

```python
# backend/app/api/health_api.py
from fastapi import APIRouter

router = APIRouter()

@router.get("/api/health")
def health_check():
    return {"status": "ok"}
```

```python
# backend/app/main.py
from fastapi import FastAPI
from app.api.health_api import router as health_router

app = FastAPI(title="Unified Test & Eval Platform")
app.include_router(health_router)
```

**Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/api/test_health_api.py::test_health_check -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/pyproject.toml backend/app/main.py backend/app/api/health_api.py backend/tests/api/test_health_api.py
git commit -m "chore: bootstrap backend skeleton and health endpoint"
```

### Task 2: Add Database Base, Session, and First Migration

**Files:**
- Create: `backend/app/infrastructure/db/base.py`
- Create: `backend/app/infrastructure/db/session.py`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/versions/20260319_01_init_core_tables.py`
- Create: `backend/tests/db/test_tables_exist.py`

**Step 1: Write the failing test**

```python
from sqlalchemy import inspect
from app.infrastructure.db.session import engine

def test_core_tables_exist():
    names = set(inspect(engine).get_table_names())
    assert "project" in names
    assert "suite" in names
    assert "case_item" in names
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/db/test_tables_exist.py::test_core_tables_exist -v`  
Expected: FAIL because tables are missing.

**Step 3: Write minimal implementation**

```python
# backend/app/infrastructure/db/base.py
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass
```

```python
# backend/app/infrastructure/db/session.py
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/unified_test_eval")
engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
```

Create migration with approved DDL for:
- `project`, `suite`, `case_item`
- baseline indexes from design

**Step 4: Run migration + test**

Run: `cd backend && alembic upgrade head && pytest tests/db/test_tables_exist.py::test_core_tables_exist -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/infrastructure/db backend/alembic.ini backend/alembic backend/tests/db/test_tables_exist.py
git commit -m "feat: add db base/session and initial core-table migration"
```

### Task 3: Add Full v1 Schema Migrations

**Files:**
- Modify: `backend/alembic/versions/20260319_01_init_core_tables.py`
- Create: `backend/alembic/versions/20260319_02_add_remaining_tables.py`
- Create: `backend/tests/db/test_all_tables_exist.py`

**Step 1: Write the failing test**

```python
from sqlalchemy import inspect
from app.infrastructure.db.session import engine

def test_all_v1_tables_exist():
    expected = {
        "project","suite","case_item","rule_definition","rule_project_rel","rule_suite_rel",
        "dataset","dataset_item","evaluator","environment","prompt_template",
        "run_record","run_item","run_log","judge_record","report_record","version_snapshot"
    }
    names = set(inspect(engine).get_table_names())
    assert expected.issubset(names)
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/db/test_all_tables_exist.py::test_all_v1_tables_exist -v`  
Expected: FAIL with missing tables.

**Step 3: Write minimal implementation**

Create migration with all remaining approved tables and indexes, including:
- `run_record.status` enum/check values:
  - `pending/queued/running/partially_success/success/failed/canceled/timeout`
- `run_item.status` enum/check values:
  - `pending/running/retrying/success/failed/skipped/canceled`
- `run_record.idempotency_key` unique index

**Step 4: Run migration + test**

Run: `cd backend && alembic upgrade head && pytest tests/db/test_all_tables_exist.py::test_all_v1_tables_exist -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/alembic/versions backend/tests/db/test_all_tables_exist.py
git commit -m "feat: add complete v1 schema migrations with status and idempotency constraints"
```

### Task 4: Implement JSON Schema Registry for `case_item`

**Files:**
- Create: `backend/app/domain/services/schema_registry_service.py`
- Create: `backend/app/domain/schemas/case_input_api.schema.json`
- Create: `backend/app/domain/schemas/case_input_agent.schema.json`
- Create: `backend/app/domain/schemas/case_expected_api.schema.json`
- Create: `backend/app/domain/schemas/case_expected_reference.schema.json`
- Create: `backend/app/domain/schemas/case_eval_config.schema.json`
- Create: `backend/tests/domain/test_case_schema_registry.py`

**Step 1: Write the failing test**

```python
import pytest
from app.domain.services.schema_registry_service import CaseSchemaRegistry

def test_invalid_case_input_rejected():
    payload = {"schema_version": "1.0", "method": "POST"}  # missing path
    with pytest.raises(ValueError):
        CaseSchemaRegistry.validate_input_payload("api", payload)
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/domain/test_case_schema_registry.py::test_invalid_case_input_rejected -v`  
Expected: FAIL (registry not implemented).

**Step 3: Write minimal implementation**

```python
from jsonschema import validate, ValidationError

class CaseSchemaRegistry:
    @staticmethod
    def validate_input_payload(case_type: str, payload: dict) -> None:
        schema = ...  # load by case_type
        try:
            validate(instance=payload, schema=schema)
        except ValidationError as e:
            raise ValueError(f"invalid input_payload: {e.message}") from e
```

**Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/domain/test_case_schema_registry.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/domain/services/schema_registry_service.py backend/app/domain/schemas backend/tests/domain/test_case_schema_registry.py
git commit -m "feat: enforce case_item json schema validation via registry service"
```

### Task 5: Implement Project/Suite/Case APIs with Validation

**Files:**
- Create: `backend/app/api/project_api.py`
- Create: `backend/app/api/suite_api.py`
- Create: `backend/app/api/case_api.py`
- Create: `backend/app/application/project_service.py`
- Create: `backend/app/application/asset_service.py`
- Create: `backend/app/infrastructure/repositories/project_repository.py`
- Create: `backend/app/infrastructure/repositories/suite_repository.py`
- Create: `backend/app/infrastructure/repositories/case_repository.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/api/test_case_create_validation.py`

**Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from app.main import app

def test_create_case_rejects_invalid_payload():
    client = TestClient(app)
    resp = client.post("/api/cases", json={
        "projectId": 1, "suiteId": 1, "name": "bad", "caseType": "api",
        "inputPayload": {"schema_version": "1.0", "method": "POST"}
    })
    assert resp.status_code == 400
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/api/test_case_create_validation.py::test_create_case_rejects_invalid_payload -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Wire `/api/projects`, `/api/suites`, `/api/cases` endpoints.
- In `AssetService.create_case`, call `CaseSchemaRegistry` before insert.
- Return standardized response format (`code/message/requestId/data`).

**Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/api/test_case_create_validation.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/api backend/app/application backend/app/infrastructure/repositories backend/app/main.py backend/tests/api/test_case_create_validation.py
git commit -m "feat: add project suite case apis with schema-gated case creation"
```

### Task 6: Implement Rule/Dataset/Evaluator/Environment/Prompt APIs

**Files:**
- Create: `backend/app/api/rule_api.py`
- Create: `backend/app/api/dataset_api.py`
- Create: `backend/app/api/evaluator_api.py`
- Create: `backend/app/api/environment_api.py`
- Create: `backend/app/api/prompt_api.py`
- Create: `backend/app/application/rule_service.py`
- Modify: `backend/app/application/asset_service.py`
- Create: `backend/tests/api/test_rule_bindings.py`

**Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from app.main import app

def test_bind_rule_to_project():
    client = TestClient(app)
    resp = client.post("/api/rules/1/bind-projects", json={"projectIds":[1,2]})
    assert resp.status_code == 200
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/api/test_rule_bindings.py::test_bind_rule_to_project -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add CRUD endpoints and bind APIs:
  - `/api/rules/{ruleId}/bind-projects`
  - `/api/rules/{ruleId}/bind-suites`
- Add dataset item import endpoint and evaluator CRUD endpoint.

**Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/api/test_rule_bindings.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/api backend/app/application backend/tests/api/test_rule_bindings.py
git commit -m "feat: add rule dataset evaluator environment prompt api modules"
```

### Task 7: Implement Run APIs with Idempotency and Status Machine

**Files:**
- Create: `backend/app/api/run_api.py`
- Create: `backend/app/application/run_service.py`
- Create: `backend/app/domain/services/run_state_machine.py`
- Create: `backend/app/infrastructure/repositories/run_repository.py`
- Create: `backend/tests/application/test_run_idempotency.py`
- Create: `backend/tests/domain/test_run_state_machine.py`

**Step 1: Write the failing tests**

```python
def test_duplicate_idempotency_key_returns_same_run():
    ...
```

```python
def test_invalid_status_transition_rejected():
    ...
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/application/test_run_idempotency.py tests/domain/test_run_state_machine.py -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add endpoints:
  - `POST /api/runs/api`
  - `POST /api/runs/agent-eval`
  - `GET /api/runs/{runId}`
  - `GET /api/runs`
  - `POST /api/runs/{runId}/cancel`
  - `POST /api/runs/{runId}/retry-failed`
- Enforce `Idempotency-Key` for run creation.
- Implement state transition guard.

**Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/application/test_run_idempotency.py tests/domain/test_run_state_machine.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/api/run_api.py backend/app/application/run_service.py backend/app/domain/services/run_state_machine.py backend/app/infrastructure/repositories/run_repository.py backend/tests/application/test_run_idempotency.py backend/tests/domain/test_run_state_machine.py
git commit -m "feat: add run apis with idempotency and state machine guards"
```

### Task 8: Add Celery Workers and Queue Dispatch

**Files:**
- Create: `backend/app/infrastructure/mq/celery_app.py`
- Create: `backend/app/workers/execution_worker.py`
- Create: `backend/app/workers/generation_worker.py`
- Create: `backend/app/workers/judge_worker.py`
- Create: `backend/app/workers/report_worker.py`
- Modify: `backend/app/application/run_service.py`
- Create: `backend/tests/workers/test_dispatch_run_items.py`

**Step 1: Write the failing test**

```python
def test_run_creation_dispatches_run_items():
    ...
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/workers/test_dispatch_run_items.py -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Configure Celery with Redis broker.
- Dispatch one task per `run_item`.
- Persist queue metadata and initial `queued` status.

**Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/workers/test_dispatch_run_items.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/infrastructure/mq backend/app/workers backend/app/application/run_service.py backend/tests/workers/test_dispatch_run_items.py
git commit -m "feat: add celery workers and run-item dispatch pipeline"
```

### Task 9: Implement Pytest Runner Adapter and API Execution Flow

**Files:**
- Create: `backend/app/domain/runners/pytest_runner_adapter.py`
- Create: `backend/app/infrastructure/pytest_runner/yaml_renderer.py`
- Modify: `backend/app/workers/execution_worker.py`
- Create: `backend/tests/domain/test_pytest_runner_adapter.py`
- Create: `backend/tests/integration/test_api_execution_flow.py`

**Step 1: Write the failing tests**

```python
def test_yaml_render_contains_run_snapshot_version():
    ...
```

```python
def test_api_case_execution_persists_assertion_result():
    ...
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/domain/test_pytest_runner_adapter.py tests/integration/test_api_execution_flow.py -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Render temporary YAML per run (`run_id`-scoped).
- Call pytest with parameterized config.
- Persist `request_data/response_data/assertion_result`.

**Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/domain/test_pytest_runner_adapter.py tests/integration/test_api_execution_flow.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/domain/runners/pytest_runner_adapter.py backend/app/infrastructure/pytest_runner/yaml_renderer.py backend/app/workers/execution_worker.py backend/tests/domain/test_pytest_runner_adapter.py backend/tests/integration/test_api_execution_flow.py
git commit -m "feat: implement pytest runner adapter and api execution persistence"
```

### Task 10: Implement Evaluator Engine + Unified Model Gateway

**Files:**
- Create: `backend/app/domain/evaluators/base.py`
- Create: `backend/app/domain/evaluators/exact_match.py`
- Create: `backend/app/domain/evaluators/json_match.py`
- Create: `backend/app/domain/evaluators/rule_based.py`
- Create: `backend/app/domain/evaluators/llm_judge.py`
- Create: `backend/app/domain/evaluators/composite.py`
- Create: `backend/app/infrastructure/llm/model_gateway_client.py`
- Create: `backend/app/application/evaluation_service.py`
- Create: `backend/tests/domain/test_composite_evaluator.py`
- Create: `backend/tests/domain/test_llm_gateway_only.py`

**Step 1: Write the failing tests**

```python
def test_composite_evaluator_weighted_total_score():
    ...
```

```python
def test_llm_judge_uses_model_gateway_client_only():
    ...
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/domain/test_composite_evaluator.py tests/domain/test_llm_gateway_only.py -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement `evaluate(case_or_item, output, expected, evaluator_config) -> score_result`.
- Implement `score_result` structure with `total_score/passed/threshold/dimensions`.
- Ensure `LLMJudgeEvaluator` only calls `model_gateway_client`.

**Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/domain/test_composite_evaluator.py tests/domain/test_llm_gateway_only.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/domain/evaluators backend/app/infrastructure/llm/model_gateway_client.py backend/app/application/evaluation_service.py backend/tests/domain/test_composite_evaluator.py backend/tests/domain/test_llm_gateway_only.py
git commit -m "feat: add pluggable evaluator engine with unified model gateway integration"
```

### Task 11: Implement Agent Evaluation Flow and Judge Records

**Files:**
- Modify: `backend/app/workers/execution_worker.py`
- Modify: `backend/app/application/evaluation_service.py`
- Create: `backend/app/domain/runners/agent_executor_adapter.py`
- Create: `backend/tests/integration/test_agent_eval_flow.py`

**Step 1: Write the failing test**

```python
def test_agent_eval_persists_score_result_and_judge_record():
    ...
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/integration/test_agent_eval_flow.py -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Assemble `DatasetItem/Case` input.
- Invoke agent endpoint through executor adapter.
- Evaluate with exact/json/rule/judge/composite as configured.
- Persist `run_item.score_result` and `judge_record`.

**Step 4: Run test to verify it passes**

Run: `cd backend && pytest tests/integration/test_agent_eval_flow.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/workers/execution_worker.py backend/app/application/evaluation_service.py backend/app/domain/runners/agent_executor_adapter.py backend/tests/integration/test_agent_eval_flow.py
git commit -m "feat: implement agent evaluation flow with score and judge persistence"
```

### Task 12: Implement Report APIs (Summary/Detail/Comparison)

**Files:**
- Create: `backend/app/api/report_api.py`
- Create: `backend/app/application/report_service.py`
- Create: `backend/tests/api/test_report_endpoints.py`

**Step 1: Write the failing test**

```python
def test_get_run_summary_report():
    ...
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/api/test_report_endpoints.py::test_get_run_summary_report -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement:
  - `GET /api/reports/run/{runId}`
  - `GET /api/reports/run/{runId}/detail`
  - `GET /api/reports/compare?runId1=&runId2=`
  - `POST /api/reports/run/{runId}/export`
- Include model/environment/rule version metadata in summary output.

**Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/api/test_report_endpoints.py -v`  
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/api/report_api.py backend/app/application/report_service.py backend/tests/api/test_report_endpoints.py
git commit -m "feat: add report api module for summary detail comparison and export"
```

### Task 13: Add Frontend Shell and Two Workbench Pages

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/layout/AppLayout.tsx`
- Create: `frontend/src/pages/workbench/ApiTestWorkbench.tsx`
- Create: `frontend/src/pages/workbench/AgentEvalWorkbench.tsx`
- Create: `frontend/src/pages/assets/AssetsCenter.tsx`
- Create: `frontend/src/pages/rules/RulesCenter.tsx`
- Create: `frontend/src/pages/execution/ExecutionCenter.tsx`
- Create: `frontend/src/pages/reports/ReportsCenter.tsx`
- Create: `frontend/src/services/apiClient.ts`
- Create: `frontend/src/services/runService.ts`
- Create: `frontend/src/services/reportService.ts`
- Create: `frontend/tests/workbench/workbench-routing.test.tsx`

**Step 1: Write the failing test**

```tsx
it("renders both workbench menu entries", () => {
  render(<App />);
  expect(screen.getByText("API 测试工作台")).toBeInTheDocument();
  expect(screen.getByText("Agent 评测工作台")).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- workbench-routing.test.tsx`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Build sidebar menus exactly per approved IA.
- Implement placeholder workflow steps on both workbench pages.
- Wire run/report fetch calls to backend endpoints.

**Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- workbench-routing.test.tsx`  
Expected: PASS.

**Step 5: Commit**

```bash
git add frontend
git commit -m "feat: add frontend shell with api and agent workbench pages"
```

### Task 14: Observability, Audit, and Delivery Readiness

**Files:**
- Create: `backend/app/infrastructure/logging/request_id_middleware.py`
- Create: `backend/app/infrastructure/logging/audit_logger.py`
- Create: `backend/app/infrastructure/monitoring/metrics.py`
- Create: `infra/docker-compose.yml`
- Create: `infra/prometheus/prometheus.yml`
- Create: `docs/runbooks/local-dev.md`
- Create: `docs/runbooks/release-checklist.md`
- Create: `backend/tests/integration/test_request_id_and_audit.py`

**Step 1: Write the failing test**

```python
def test_request_id_is_attached_and_audit_log_written():
    ...
```

**Step 2: Run test to verify it fails**

Run: `cd backend && pytest tests/integration/test_request_id_and_audit.py -v`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add request-id middleware and response propagation.
- Add audit log for create/update/delete operations.
- Add metrics for run status counters and evaluator latency.
- Add local compose stack (postgres/redis/minio/prometheus).

**Step 4: Run tests + smoke checks**

Run: `cd backend && pytest tests/integration/test_request_id_and_audit.py -v`  
Expected: PASS.  
Run: `docker compose -f infra/docker-compose.yml config`  
Expected: Valid compose config.

**Step 5: Commit**

```bash
git add backend/app/infrastructure/logging backend/app/infrastructure/monitoring infra docs/runbooks backend/tests/integration/test_request_id_and_audit.py
git commit -m "chore: add observability audit and local delivery runbooks"
```

## Final Verification Task

**Files:**
- Modify: `docs/plans/2026-03-19-unified-test-eval-platform-v1-implementation.md`

**Step 1: Run backend full test suite**

Run: `cd backend && pytest -q`  
Expected: all tests PASS.

**Step 2: Run frontend test suite**

Run: `cd frontend && npm test -- --runInBand`  
Expected: all tests PASS.

**Step 3: Run schema/migration checks**

Run: `cd backend && alembic upgrade head && alembic downgrade -1 && alembic upgrade head`  
Expected: migrations upgrade/downgrade cleanly.

**Step 4: Write final implementation notes**

Record known limitations:
- Replay remains v2 scope.
- Multi-tenant remains v2 scope.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-19-unified-test-eval-platform-v1-implementation.md
git commit -m "docs: add v1 implementation execution and verification checklist"
```

## Execution Notes (2026-03-19)

Implemented tasks:

- Task 1 through Task 14 completed in this session.

Verification summary:

- Backend full tests: `cd backend && pytest -q` -> `17 passed`.
- Frontend tests:
  - `cd frontend && npm test -- --runInBand` fails because Vitest does not support `--runInBand`.
  - `cd frontend && npm test` -> `1 passed`.
- Migration checks:
  - `cd backend && alembic upgrade head && alembic downgrade -1 && alembic upgrade head` passed.
- Compose validation:
  - `docker compose -f infra/docker-compose.yml config` could not be validated on this machine because Docker Compose plugin is unavailable (`unknown shorthand flag: 'f' in -f`).
  - `docker-compose` binary is also not installed.

Known limitations:

- One-click report replay remains v2 scope.
- Multi-tenant support remains v2 scope.
- `ruleVersions` in report metadata is currently placeholder (`[]`) until rule-version linkage is added in later tasks.
- Local async execution currently supports Celery with Redis when available and includes a test-friendly stub fallback when Celery is unavailable.
