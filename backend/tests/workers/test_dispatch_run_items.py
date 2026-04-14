from pathlib import Path
import sys
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.repositories.table_repository import TableRepository
from app.main import app
from app.workers import execution_worker
from app.application.run_service import RunService
import app.application.run_service as run_service_module


def test_run_creation_dispatches_run_items(monkeypatch):
    monkeypatch.setenv("RUN_DISPATCH_MODE", "async")
    dispatched_run_item_ids: list[int] = []

    def fake_delay(run_item_id: int):
        dispatched_run_item_ids.append(run_item_id)
        return {"task_id": f"task-{run_item_id}"}

    monkeypatch.setattr(execution_worker.execute_run_item, "delay", fake_delay)

    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Dispatch Project",
            "projectType": "hybrid",
            "description": "project for dispatch tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Dispatch Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Dispatch Env",
            "envType": "test",
            "baseUrl": "http://localhost:8000",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "Dispatch Case",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "POST",
                "path": "/api/order/create",
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"code": 0},
            },
        },
    )
    assert case_response.status_code == 200
    case_id = case_response.json()["data"]["id"]

    run_response = client.post(
        "/api/runs/api",
        headers={"Idempotency-Key": f"dispatch-run-{uuid4().hex}"},
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "environmentId": environment_id,
        },
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]

    run_items = TableRepository("run_item").list({"run_id": run_id})

    assert len(run_items) == 1
    assert run_items[0]["case_id"] == case_id
    assert run_items[0]["item_type"] == "api_case"
    assert run_items[0]["status"] == "pending"
    assert dispatched_run_item_ids == [run_items[0]["id"]]


def test_dispatch_defaults_to_background_thread(monkeypatch):
    monkeypatch.delenv("RUN_DISPATCH_MODE", raising=False)
    captured: dict[str, object] = {}

    class FakeThread:
        def __init__(self, *, target, args, daemon, name):
            captured["target"] = target
            captured["args"] = args
            captured["daemon"] = daemon
            captured["name"] = name

        def start(self):
            captured["started"] = True

    monkeypatch.setattr(run_service_module, "Thread", FakeThread)
    RunService._dispatch_run_items([{"id": 101, "run_id": 88}])

    assert captured["started"] is True
    assert captured["daemon"] is True
    assert captured["name"] == "run-dispatch-88"
