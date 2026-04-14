from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.logging.audit_logger import audit_logger
from app.main import app


def test_request_id_is_attached_and_audit_log_written():
    audit_logger.reset()
    client = TestClient(app)

    response = client.post(
        "/api/projects",
        headers={"X-Request-ID": "req-audit-001"},
        json={
            "name": "Audit Project",
            "projectType": "hybrid",
            "description": "project for request id and audit test",
        },
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "req-audit-001"

    body = response.json()
    assert body["requestId"] == "req-audit-001"

    events = audit_logger.get_events()
    assert len(events) == 1
    assert events[0]["request_id"] == "req-audit-001"
    assert events[0]["method"] == "POST"
    assert events[0]["path"] == "/api/projects"
    assert events[0]["status_code"] == 200
