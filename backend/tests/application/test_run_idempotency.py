from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def test_duplicate_idempotency_key_returns_same_run():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Run Idempotency Project",
            "projectType": "hybrid",
            "description": "project for run tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Run Idempotency Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Run Idempotency Environment",
            "envType": "test",
            "baseUrl": "http://localhost:8000",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    headers = {"Idempotency-Key": "run-idempotency-001"}
    payload = {"projectId": project_id, "suiteId": suite_id, "environmentId": environment_id}

    first_response = client.post("/api/runs/api", json=payload, headers=headers)
    assert first_response.status_code == 200
    first_run = first_response.json()["data"]

    second_response = client.post("/api/runs/api", json=payload, headers=headers)
    assert second_response.status_code == 200
    second_run = second_response.json()["data"]

    assert first_run["id"] == second_run["id"]
    assert first_run["run_no"] == second_run["run_no"]
