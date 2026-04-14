from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.application.run_schedule_service import RunScheduleService
from app.main import app


def _create_due_api_schedule(client: TestClient, *, prefix: str) -> tuple[int, int]:
    project_response = client.post(
        "/api/projects",
        json={
            "name": f"{prefix} Project {uuid4().hex[:6]}",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": f"{prefix} Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": f"{prefix} Env",
            "envType": "test",
            "baseUrl": "http://localhost:18080",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": f"{prefix} Case",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "GET",
                "path": "/healthz",
                "headers": {"Content-Type": "application/json"},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"status": "ok"},
            },
        },
    )
    assert case_response.status_code == 200

    schedule_response = client.post(
        "/api/run-schedules",
        json={
            "name": f"{prefix} schedule",
            "runType": "api_test",
            "projectId": project_id,
            "suiteId": suite_id,
            "environmentId": environment_id,
            "dailyTime": "09:30",
            "nextRunAt": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        },
    )
    assert schedule_response.status_code == 200
    return project_id, schedule_response.json()["data"]["id"]


def test_validate_feishu_app_channel_fields():
    service = RunScheduleService()
    service._validate_feishu_app_channel(
        {
            "app_id": "cli_test",
            "app_secret": "secret_test",
            "chat_id": "oc_test",
        }
    )

    with pytest.raises(ValueError, match="report channel app_id is required"):
        service._validate_feishu_app_channel({"app_secret": "x", "chat_id": "oc_x"})
    with pytest.raises(ValueError, match="report channel app_secret is required"):
        service._validate_feishu_app_channel({"app_id": "cli_x", "chat_id": "oc_x"})
    with pytest.raises(ValueError, match="report channel chat_id is required"):
        service._validate_feishu_app_channel({"app_id": "cli_x", "app_secret": "x"})


def test_report_delivery_without_channel_is_normalized_to_disabled():
    service = RunScheduleService()
    normalized = service._normalize_report_delivery(
        {
            "enabled": True,
            "message": "nightly report",
            "customChannel": {
                "channelType": "feishu_app",
                "appId": "cli_custom",
                "appSecret": "secret_custom",
                "chatId": "oc_custom",
            },
        },
        suite_id=None,
    )
    assert normalized["enabled"] is False
    assert normalized["channel_asset_id"] is None
    assert normalized["custom_channel"] is None
    assert normalized["message"] == "nightly report"
    assert normalized["summary_scope"] == "project"
    assert normalized["include_report_page_screenshot"] is True


def test_report_delivery_suite_scope_requires_schedule_suite_id():
    service = RunScheduleService()
    with pytest.raises(ValueError, match="summary_scope set to suite requires schedule suite_id"):
        service._normalize_report_delivery(
            {
                "enabled": True,
                "summaryScope": "suite",
            },
            suite_id=None,
        )


def test_dispatch_due_schedule_creates_scheduled_run(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_ENABLED", "false")
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Schedule Project {uuid4().hex[:6]}",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Schedule API Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Schedule Env",
            "envType": "test",
            "baseUrl": "http://localhost:18080",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    channel_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "report_channel",
            "name": "Schedule Feishu Channel",
            "contentJson": {
                "channel_type": "feishu_app",
                "app_id": "cli_schedule",
                "app_secret": "secret_schedule",
                "chat_id": "oc_schedule",
                "default_message": "daily schedule notify",
            },
        },
    )
    assert channel_response.status_code == 200
    channel_id = channel_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "Schedule API Case",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "GET",
                "path": "/healthz",
                "headers": {"Content-Type": "application/json"},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"status": "ok"},
            },
        },
    )
    assert case_response.status_code == 200

    schedule_response = client.post(
        "/api/run-schedules",
        json={
            "name": "API smoke schedule",
            "runType": "api_test",
            "projectId": project_id,
            "suiteId": suite_id,
            "environmentId": environment_id,
            "dailyTime": "09:30",
            "reportDelivery": {
                "enabled": True,
                "channelAssetId": channel_id,
                "message": "nightly report",
            },
            "nextRunAt": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        },
    )
    assert schedule_response.status_code == 200
    schedule_id = schedule_response.json()["data"]["id"]

    results = RunScheduleService().dispatch_due_schedules()
    matched = [item for item in results if item["schedule_id"] == schedule_id]
    assert matched, "expected schedule to be dispatched"
    assert matched[0]["status"] == "triggered"

    schedule_detail_response = client.get(f"/api/run-schedules/{schedule_id}")
    assert schedule_detail_response.status_code == 200
    schedule_detail = schedule_detail_response.json()["data"]
    assert isinstance(schedule_detail["last_run_id"], int)
    assert schedule_detail["trigger_count"] >= 1
    report_delivery = schedule_detail.get("meta_info", {}).get("report_delivery", {})
    assert report_delivery.get("enabled") is True
    assert report_delivery.get("channel_asset_id") == channel_id
    assert report_delivery.get("message") == "nightly report"
    assert report_delivery.get("summary_scope") == "suite"
    assert report_delivery.get("include_report_page_screenshot") is True

    run_response = client.get(f"/api/runs/{schedule_detail['last_run_id']}")
    assert run_response.status_code == 200
    run_record = run_response.json()["data"]
    assert run_record["trigger_type"] == "scheduled"
    assert run_record["source_id"] == schedule_id
    assert run_record["report_delivery_status"] == "pending"


def test_dispatch_due_schedule_without_suite_runs_all_project_cases(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_ENABLED", "false")
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Schedule All Suites {uuid4().hex[:6]}",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_a_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Suite A",
            "suiteType": "api",
        },
    )
    assert suite_a_response.status_code == 200
    suite_a_id = suite_a_response.json()["data"]["id"]

    suite_b_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Suite B",
            "suiteType": "api",
        },
    )
    assert suite_b_response.status_code == 200
    suite_b_id = suite_b_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Schedule Env",
            "envType": "test",
            "baseUrl": "http://localhost:18080",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_a_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_a_id,
            "name": "Case Suite A",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "GET",
                "path": "/healthz",
                "headers": {"Content-Type": "application/json"},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"status": "ok"},
            },
        },
    )
    assert case_a_response.status_code == 200
    case_a_id = case_a_response.json()["data"]["id"]

    case_b_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_b_id,
            "name": "Case Suite B",
            "caseType": "api",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "GET",
                "path": "/healthz",
                "headers": {"Content-Type": "application/json"},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"status": "ok"},
            },
        },
    )
    assert case_b_response.status_code == 200
    case_b_id = case_b_response.json()["data"]["id"]

    schedule_response = client.post(
        "/api/run-schedules",
        json={
            "name": "all suites schedule",
            "runType": "api_test",
            "projectId": project_id,
            "environmentId": environment_id,
            "dailyTime": "09:30",
            "nextRunAt": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        },
    )
    assert schedule_response.status_code == 200
    schedule_id = schedule_response.json()["data"]["id"]

    results = RunScheduleService().dispatch_due_schedules()
    matched = [item for item in results if item["schedule_id"] == schedule_id]
    assert matched, "expected schedule to be dispatched"
    assert matched[0]["status"] == "triggered"

    schedule_detail_response = client.get(f"/api/run-schedules/{schedule_id}")
    assert schedule_detail_response.status_code == 200
    schedule_detail = schedule_detail_response.json()["data"]
    assert schedule_detail["suite_id"] is None
    assert isinstance(schedule_detail["last_run_id"], int)

    run_id = int(schedule_detail["last_run_id"])
    run_response = client.get(f"/api/runs/{run_id}")
    assert run_response.status_code == 200
    run_record = run_response.json()["data"]
    assert run_record["suite_id"] is None
    assert run_record["trigger_type"] == "scheduled"
    assert run_record["source_id"] == schedule_id
    assert run_record.get("summary", {}).get("total") == 2

    run_items_response = client.get(f"/api/runs/{run_id}/items")
    assert run_items_response.status_code == 200
    run_items = run_items_response.json()["data"]["items"]
    case_ids = {item.get("case_id") for item in run_items}
    assert case_ids == {case_a_id, case_b_id}


def test_claim_due_only_once_for_same_schedule_slot(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_ENABLED", "false")
    client = TestClient(app)
    _, schedule_id = _create_due_api_schedule(client, prefix="Claim Once")

    service = RunScheduleService()
    schedule = service.get_schedule(schedule_id)
    due_at = service._coerce_datetime(schedule.get("next_run_at"))
    assert due_at is not None
    current = datetime.now(timezone.utc)
    next_run_at = service._next_run_at(schedule, current)

    first_claim = service.schedule_repository.claim_due(
        schedule_id,
        expected_next_run_at=due_at,
        now=current,
        next_run_at=next_run_at,
    )
    second_claim = service.schedule_repository.claim_due(
        schedule_id,
        expected_next_run_at=due_at,
        now=current,
        next_run_at=next_run_at,
    )

    assert first_claim is True
    assert second_claim is False


def test_dispatch_due_schedules_same_slot_reuses_existing_run(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_ENABLED", "false")
    client = TestClient(app)
    _, schedule_id = _create_due_api_schedule(client, prefix="Stable Key")

    service = RunScheduleService()
    schedule = service.get_schedule(schedule_id)
    due_at = service._coerce_datetime(schedule.get("next_run_at"))
    assert due_at is not None
    dispatch_now = due_at + timedelta(seconds=1)

    # Simulate two dispatcher instances reading the same due schedule snapshot.
    monkeypatch.setattr(
        service.schedule_repository,
        "list_due",
        lambda *, now, limit=20: [dict(schedule)],
    )
    monkeypatch.setattr(
        service.schedule_repository,
        "claim_due",
        lambda *_args, **_kwargs: True,
    )

    first = service.dispatch_due_schedules(now=dispatch_now, limit=1)
    second = service.dispatch_due_schedules(now=dispatch_now, limit=1)

    assert first and first[0]["status"] == "triggered"
    assert second and second[0]["status"] == "triggered"
    assert first[0]["run_id"] == second[0]["run_id"]


def test_create_schedule_same_config_reuses_existing_schedule(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_ENABLED", "false")
    client = TestClient(app)
    project_id, schedule_id = _create_due_api_schedule(client, prefix="Reuse Existing")

    existing_response = client.get(f"/api/run-schedules/{schedule_id}")
    assert existing_response.status_code == 200
    existing = existing_response.json()["data"]

    duplicate_create_response = client.post(
        "/api/run-schedules",
        json={
            "name": "Reuse Existing schedule renamed",
            "runType": "api_test",
            "projectId": project_id,
            "suiteId": existing["suite_id"],
            "environmentId": existing["environment_id"],
            "dailyTime": existing["daily_time"],
        },
    )
    assert duplicate_create_response.status_code == 200
    reused = duplicate_create_response.json()["data"]
    assert reused["id"] == schedule_id
    assert reused["name"] == "Reuse Existing schedule renamed"

    list_response = client.get("/api/run-schedules", params={"projectId": project_id})
    assert list_response.status_code == 200
    items = list_response.json()["data"]["items"]
    same_target = [
        item
        for item in items
        if item.get("suite_id") == existing["suite_id"]
        and item.get("environment_id") == existing["environment_id"]
        and item.get("daily_time") == existing["daily_time"]
        and item.get("run_type") == "api_test"
    ]
    assert len(same_target) == 1
