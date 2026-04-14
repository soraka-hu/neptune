from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def test_create_case_rejects_invalid_payload():
    client = TestClient(app)
    resp = client.post(
        "/api/cases",
        json={
            "projectId": 1,
            "suiteId": 1,
            "name": "bad",
            "caseType": "api",
            "inputPayload": {"schema_version": "1.0", "method": "POST"},
        },
    )
    assert resp.status_code == 400
