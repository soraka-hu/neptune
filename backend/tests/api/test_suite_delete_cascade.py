from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def _create_case(client: TestClient, *, project_id: int, suite_id: int, name: str) -> int:
    response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": name,
            "caseType": "api",
            "sourceType": "manual",
            "status": "active",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "POST",
                "path": "/api/order/create",
                "headers": {"Content-Type": "application/json"},
                "query": {},
                "body": {"userId": 1001, "skuId": 2002, "count": 1},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"code": 0, "message": "success"},
            },
        },
    )
    assert response.status_code == 200
    return int(response.json()["data"]["id"])


def test_delete_suite_archives_related_cases():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Suite Cascade Project",
            "projectType": "hybrid",
            "description": "suite delete should archive child cases",
        },
    )
    assert project_response.status_code == 200
    project_id = int(project_response.json()["data"]["id"])

    suite_a = client.post(
        "/api/suites",
        json={"projectId": project_id, "name": "Suite A", "suiteType": "api"},
    )
    suite_b = client.post(
        "/api/suites",
        json={"projectId": project_id, "name": "Suite B", "suiteType": "api"},
    )
    assert suite_a.status_code == 200 and suite_b.status_code == 200
    suite_a_id = int(suite_a.json()["data"]["id"])
    suite_b_id = int(suite_b.json()["data"]["id"])

    case_a_id = _create_case(client, project_id=project_id, suite_id=suite_a_id, name="Suite A Case")
    case_b_id = _create_case(client, project_id=project_id, suite_id=suite_b_id, name="Suite B Case")

    delete_response = client.delete(f"/api/suites/{suite_a_id}")
    assert delete_response.status_code == 200
    assert int(delete_response.json()["data"]["archived_case_count"]) == 1

    suite_a_cases = client.get(f"/api/cases?projectId={project_id}&suiteId={suite_a_id}&caseType=api")
    assert suite_a_cases.status_code == 200
    assert suite_a_cases.json()["data"]["total"] == 0

    suite_b_cases = client.get(f"/api/cases?projectId={project_id}&suiteId={suite_b_id}&caseType=api")
    assert suite_b_cases.status_code == 200
    assert suite_b_cases.json()["data"]["total"] == 1
    assert int(suite_b_cases.json()["data"]["items"][0]["id"]) == case_b_id

    case_a_detail = client.get(f"/api/cases/{case_a_id}")
    assert case_a_detail.status_code == 200
    assert case_a_detail.json()["data"]["status"] == "archived"

    case_b_detail = client.get(f"/api/cases/{case_b_id}")
    assert case_b_detail.status_code == 200
    assert case_b_detail.json()["data"]["status"] == "active"
