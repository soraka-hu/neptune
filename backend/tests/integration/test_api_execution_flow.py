import json
from pathlib import Path
import sys
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.repositories.table_repository import TableRepository
from app.main import app
from app.workers.execution_worker import execute_run_item


class _MockHttpResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self._status_code = status_code
        self._body = json.dumps(payload).encode("utf-8")
        self.headers = {"Content-Type": "application/json"}

    def getcode(self) -> int:
        return self._status_code

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _mock_urlopen(request_obj, timeout):  # noqa: ARG001
    if request_obj.full_url.endswith("/api/order/create"):
        return _MockHttpResponse(200, {"code": 0, "message": "success"})
    return _MockHttpResponse(404, {"code": 404, "message": "not_found"})


def test_api_case_execution_persists_assertion_result(monkeypatch):
    client = TestClient(app)
    base_url = "http://mocked.local"
    monkeypatch.setattr("app.domain.runners.pytest_runner_adapter.urllib_request.urlopen", _mock_urlopen)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Execution Flow Project",
            "projectType": "hybrid",
            "description": "project for execution flow tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Execution Flow Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Execution Flow Env",
            "envType": "test",
            "baseUrl": base_url,
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "Execution Flow Case",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "POST",
                "path": "/api/order/create",
                "headers": {"Content-Type": "application/json"},
                "body": {"userId": 1001},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"code": 0, "message": "success"},
            },
            "assertionConfig": {
                "strategy": "json_fields",
                "checks": [
                    {"path": "$.code", "op": "eq", "value": 0},
                    {"path": "$.message", "op": "eq", "value": "success"},
                ],
            },
        },
    )
    assert case_response.status_code == 200

    run_response = client.post(
        "/api/runs/api",
        headers={"Idempotency-Key": f"api-execution-{uuid4().hex}"},
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "environmentId": environment_id,
        },
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]

    run_item = TableRepository("run_item").list({"run_id": run_id})[0]
    execute_run_item(run_item["id"])

    updated_run_item = TableRepository("run_item").get(run_item["id"])
    assert updated_run_item["request_data"]["case_version"] == 1
    assert updated_run_item["request_data"]["rendered_yaml_path"]
    assert updated_run_item["request_data"]["url"].startswith(base_url)
    assert updated_run_item["response_data"]["status_code"] == 200
    assert updated_run_item["response_data"]["json"] == {"code": 0, "message": "success"}
    assert updated_run_item["assertion_result"]["passed"] is True
    assert updated_run_item["assertion_result"]["source_mode"] == "assertion_config"
    assert updated_run_item["assertion_result"]["case_assertion"]["passed"] is True
    assert len(updated_run_item["assertion_result"]["case_assertion"]["item_checks"]) == 2
    assert len(updated_run_item["assertion_result"]["effective_checks"]) >= 2
    assert all(item.get("source") != "expected_output" for item in updated_run_item["assertion_result"]["effective_checks"])
    assert updated_run_item["status"] == "success"
    run_logs = TableRepository("run_log").list({"run_id": run_id})
    assert len(run_logs) >= 2
    assert any("started" in row["content"] for row in run_logs)
    assert any("finished" in row["content"] for row in run_logs)


def test_api_execution_applies_bound_assertion_rule(monkeypatch):
    client = TestClient(app)
    base_url = "http://mocked.local"
    monkeypatch.setattr("app.domain.runners.pytest_runner_adapter.urllib_request.urlopen", _mock_urlopen)

    project = client.post(
        "/api/projects",
        json={"name": "API Rule Apply Project", "projectType": "hybrid"},
    )
    assert project.status_code == 200
    project_id = project.json()["data"]["id"]

    suite = client.post(
        "/api/suites",
        json={"projectId": project_id, "name": "API Rule Apply Suite", "suiteType": "api"},
    )
    assert suite.status_code == 200
    suite_id = suite.json()["data"]["id"]

    environment = client.post(
        "/api/environments",
        json={"projectId": project_id, "name": "API Rule Apply Env", "envType": "test", "baseUrl": base_url},
    )
    assert environment.status_code == 200
    environment_id = environment.json()["data"]["id"]

    case_resp = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "API Rule Apply Case",
            "caseType": "api",
            "inputPayload": {"schema_version": "1.0", "method": "POST", "path": "/api/order/create"},
            "expectedOutput": {"schema_version": "1.0", "status_code": 200, "json_fields": {"code": 0, "message": "success"}},
        },
    )
    assert case_resp.status_code == 200

    rule_resp = client.post(
        "/api/rules",
        json={
            "name": "Bound Assertion Rule",
            "ruleType": "assertion",
            "content": {
                "expected_status_code": 200,
                "assertion_items": [
                    {"path": "$.code", "op": "eq", "value": 0},
                    {"path": "$.message", "op": "eq", "value": "success"},
                ],
            },
        },
    )
    assert rule_resp.status_code == 200
    rule_id = rule_resp.json()["data"]["id"]

    bind_rule = client.post(
        f"/api/rules/{rule_id}/bind-suites",
        json={"suiteIds": [suite_id]},
    )
    assert bind_rule.status_code == 200

    run_response = client.post(
        "/api/runs/api",
        headers={"Idempotency-Key": f"api-rule-apply-{uuid4().hex}"},
        json={"projectId": project_id, "suiteId": suite_id, "environmentId": environment_id},
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]

    run_record = TableRepository("run_record").get(run_id)
    assert run_record is not None
    snapshot = run_record.get("request_snapshot") or {}
    assert rule_id in snapshot.get("bound_rule_ids", [])

    run_item = TableRepository("run_item").list({"run_id": run_id})[0]
    execute_run_item(run_item["id"])
    updated_run_item = TableRepository("run_item").get(run_item["id"])

    assert updated_run_item["assertion_result"]["passed"] is True
    assert rule_id in updated_run_item["assertion_result"]["applied_rule_ids"]
    assert any(check.get("source") == f"rule#{rule_id}" for check in updated_run_item["assertion_result"]["effective_checks"])


def test_api_case_polling_updates_attempts_and_keeps_running_status(monkeypatch):
    client = TestClient(app)
    base_url = "http://mocked.local"
    state = {
        "count": 0,
        "run_id": None,
        "run_item_id": None,
        "observed_run_statuses": [],
        "observed_item_statuses": [],
        "observed_item_attempt_counts": [],
    }

    def _mock_polling_urlopen(request_obj, timeout):  # noqa: ARG001
        state["count"] += 1
        if request_obj.full_url.endswith("/api/task/status"):
            run_id = state.get("run_id")
            run_item_id = state.get("run_item_id")
            if isinstance(run_id, int) and isinstance(run_item_id, int) and state["count"] > 1:
                run_record = TableRepository("run_record").get(run_id)
                run_item_record = TableRepository("run_item").get(run_item_id)
                if isinstance(run_record, dict):
                    state["observed_run_statuses"].append(run_record.get("status"))
                if isinstance(run_item_record, dict):
                    state["observed_item_statuses"].append(run_item_record.get("status"))
                    request_data = run_item_record.get("request_data")
                    attempt_count = request_data.get("attempt_count") if isinstance(request_data, dict) else None
                    state["observed_item_attempt_counts"].append(attempt_count)
            status_value = 1 if state["count"] >= 3 else 0
            return _MockHttpResponse(200, {"status": status_value, "message": "ok"})
        return _MockHttpResponse(404, {"code": 404, "message": "not_found"})

    monkeypatch.setattr("app.domain.runners.pytest_runner_adapter.urllib_request.urlopen", _mock_polling_urlopen)
    monkeypatch.setattr("app.application.run_service.RunService._dispatch_run_items", lambda self, run_items: None)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Polling Execution Project",
            "projectType": "hybrid",
            "description": "project for polling execution tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Polling Execution Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Polling Execution Env",
            "envType": "test",
            "baseUrl": base_url,
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "Polling Execution Case",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "GET",
                "path": "/api/task/status",
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"status": 1},
            },
            "assertionConfig": {
                "timeout_ms": 3000,
                "retry_count": 5,
                "retry_interval_ms": 0,
                "checks": [
                    {"path": "$.status", "op": "eq", "value": 1},
                ],
            },
        },
    )
    assert case_response.status_code == 200

    run_response = client.post(
        "/api/runs/api",
        headers={"Idempotency-Key": f"api-polling-{uuid4().hex}"},
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "environmentId": environment_id,
        },
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]
    state["run_id"] = run_id

    run_item = TableRepository("run_item").list({"run_id": run_id})[0]
    run_item_id = run_item["id"]
    state["run_item_id"] = run_item_id
    execute_run_item(run_item_id)

    updated_run = TableRepository("run_record").get(run_id)
    assert updated_run is not None
    assert updated_run["status"] == "success"

    updated_run_item = TableRepository("run_item").get(run_item_id)
    assert updated_run_item["status"] == "success"
    assert updated_run_item["request_data"]["attempt_count"] == 3
    assert updated_run_item["request_data"]["retry_count"] == 5
    assert updated_run_item["request_data"]["retry_interval_seconds"] == 0
    assert len(updated_run_item["request_data"]["attempts"]) == 3
    assert updated_run_item["request_data"]["attempts"][0]["assertion_passed"] is False
    assert updated_run_item["request_data"]["attempts"][2]["assertion_passed"] is True

    assert state["observed_run_statuses"]
    assert all(status == "running" for status in state["observed_run_statuses"])
    assert state["observed_item_statuses"]
    assert all(status == "running" for status in state["observed_item_statuses"])
    assert any(isinstance(value, int) and value >= 1 for value in state["observed_item_attempt_counts"])
