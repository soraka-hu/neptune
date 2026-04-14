from pathlib import Path
import sys
from uuid import uuid4

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.repositories.table_repository import TableRepository
from app.main import app
from app.workers.execution_worker import execute_run_item


def _create_completed_api_run(client: TestClient) -> tuple[int, int, int]:
    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Report Project {uuid4().hex[:8]}",
            "projectType": "hybrid",
            "description": "project for report tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Report Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Report Env",
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
            "name": "Report Case",
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
        },
    )
    assert case_response.status_code == 200

    run_response = client.post(
        "/api/runs/api",
        headers={"Idempotency-Key": f"report-run-{uuid4().hex}"},
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
    return project_id, suite_id, run_id


def _create_suite_fixture(client: TestClient) -> tuple[int, int, int]:
    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Suite Analytics Project {uuid4().hex[:8]}",
            "projectType": "hybrid",
            "description": "project for suite analytics tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Suite Analytics API",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Suite Analytics Env",
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
            "name": "Suite Analytics Case",
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
        },
    )
    assert case_response.status_code == 200
    return project_id, suite_id, environment_id


def _create_run_on_suite(client: TestClient, project_id: int, suite_id: int, environment_id: int) -> int:
    run_response = client.post(
        "/api/runs/api",
        headers={"Idempotency-Key": f"suite-analytics-run-{uuid4().hex}"},
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "environmentId": environment_id,
        },
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]
    return run_id


def test_get_run_summary_report():
    client = TestClient(app)
    _, _, run_id = _create_completed_api_run(client)

    response = client.get(f"/api/reports/run/{run_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["runId"] == run_id
    assert body["data"]["summary"]["total"] == 1
    assert "versionMetadata" in body["data"]


def test_report_detail_compare_and_export():
    client = TestClient(app)
    _, _, run_id_1 = _create_completed_api_run(client)
    _, _, run_id_2 = _create_completed_api_run(client)

    detail_response = client.get(f"/api/reports/run/{run_id_1}/detail")
    compare_response = client.get(f"/api/reports/compare?runId1={run_id_1}&runId2={run_id_2}")
    export_response = client.post(f"/api/reports/run/{run_id_1}/export")

    assert detail_response.status_code == 200
    assert detail_response.json()["data"]["runId"] == run_id_1
    assert len(detail_response.json()["data"]["items"]) == 1
    assert detail_response.json()["data"]["items"][0]["case_display_name"] == "Report Case"
    assert isinstance(detail_response.json()["data"]["logs"], list)
    assert len(detail_response.json()["data"]["logs"]) >= 1

    assert compare_response.status_code == 200
    assert compare_response.json()["data"]["runId1"] == run_id_1
    assert compare_response.json()["data"]["runId2"] == run_id_2

    assert export_response.status_code == 200
    assert export_response.json()["data"]["runId"] == run_id_1
    assert export_response.json()["data"]["fileUrl"]


def test_dashboard_v1_supports_all_projects_when_project_missing():
    client = TestClient(app)
    project_id_1, _, _ = _create_completed_api_run(client)
    project_id_2, _, _ = _create_completed_api_run(client)

    response = client.get("/api/reports/dashboard/v1?timeRange=all&type=all")

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["projectId"] is None
    assert body["data"]["projectName"] == "全部项目"
    project_rows = body["data"]["projects"]
    project_ids = {int(item["projectId"]) for item in project_rows}
    assert project_id_1 in project_ids
    assert project_id_2 in project_ids
    assert all("apiSuccessRate" in item for item in project_rows)


def test_export_suite_markdown_report(monkeypatch):
    def _fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, user_input, context, config
        return {
            "parsed_output": "# Suite 测试报告",
            "raw_output": "# Suite 测试报告\n\n## 执行摘要\n- 模型详细总结已生成。",
            "raw_response": {},
            "model_name": "gpt-5.4-mini",
            "model_version": None,
            "token_usage": None,
            "latency_ms": 12,
        }

    monkeypatch.setattr("app.infrastructure.llm.model_gateway_client.ModelGatewayClient.complete", _fake_complete)

    client = TestClient(app)
    _, suite_id, _ = _create_completed_api_run(client)

    response = client.post(f"/api/reports/suite/{suite_id}/export-markdown")
    assert response.status_code == 200

    body = response.json()
    assert body["code"] == 0
    data = body["data"]
    assert data["suiteId"] == suite_id
    assert data["suiteName"] == "Report Suite"
    assert data["summaryMode"] == "llm"
    assert data["model"] == "gpt-5.4-mini"
    assert data["fileName"].startswith(f"suite-{suite_id}-")
    assert data["fileName"].endswith(".md")
    assert "# Suite 测试报告" in data["markdownContent"]


def test_export_dashboard_v1_markdown_report(monkeypatch):
    def _fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, user_input, context, config
        return {
            "parsed_output": "# 项目看板测试报告",
            "raw_output": "# 项目看板测试报告\n\n## 执行摘要\n- 已按筛选生成详细总结。",
            "raw_response": {},
            "model_name": "gpt-5.4-mini",
            "model_version": None,
            "token_usage": None,
            "latency_ms": 18,
        }

    monkeypatch.setattr("app.infrastructure.llm.model_gateway_client.ModelGatewayClient.complete", _fake_complete)

    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Dashboard Markdown Project {uuid4().hex[:8]}",
            "projectType": "hybrid",
            "description": "project for dashboard markdown export test",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    response = client.post(
        f"/api/reports/dashboard/v1/export-markdown?projectId={project_id}&timeRange=30d&type=all&environment=all&model=all"
    )
    assert response.status_code == 200

    body = response.json()
    assert body["code"] == 0
    data = body["data"]
    assert data["projectId"] == project_id
    assert data["summaryMode"] == "llm"
    assert data["model"] == "gpt-5.4-mini"
    assert data["filters"]["projectId"] == project_id
    assert data["filters"]["timeRange"] == "30d"
    assert data["filters"]["type"] == "all"
    assert data["fileName"].startswith(f"dashboard-{project_id}-")
    assert data["fileName"].endswith(".md")
    assert "# 项目看板测试报告" in data["markdownContent"]


def test_export_dashboard_v1_image(monkeypatch):
    monkeypatch.setenv("NEPTUNE_WEB_BASE_URL", "https://neptune.example.com")
    monkeypatch.setenv(
        "DASHBOARD_EXPORT_IMAGE_URL_TEMPLATE",
        "https://img.example.com/export?project={project_id}&timeRange={time_range}&type={report_type}&environment={environment}&model={model}&report={project_report_url_encoded}",
    )

    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Dashboard Image Project {uuid4().hex[:8]}",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    response = client.post(
        f"/api/reports/dashboard/v1/export-image?projectId={project_id}&timeRange=30d&type=api&environment=test&model=gpt-4o"
    )
    assert response.status_code == 200

    body = response.json()
    assert body["code"] == 0
    data = body["data"]
    assert data["projectId"] == project_id
    assert data["filters"]["projectId"] == project_id
    assert data["filters"]["timeRange"] == "30d"
    assert data["filters"]["type"] == "api"
    assert data["reportPageUrl"].startswith("https://neptune.example.com/reports/project?")
    assert "projectId=" in data["reportPageUrl"]
    assert "timeRange=30d" in data["reportPageUrl"]
    assert "img.example.com/export" in data["screenshotUrl"]
    assert "project=" in data["screenshotUrl"]
    assert "model=gpt-4o" in data["screenshotUrl"]


def test_export_dashboard_v1_image_uses_default_fallback_when_env_missing(monkeypatch):
    monkeypatch.delenv("NEPTUNE_WEB_BASE_URL", raising=False)
    monkeypatch.delenv("NEPTUNE_BASE_URL", raising=False)
    monkeypatch.delenv("WEB_BASE_URL", raising=False)
    monkeypatch.delenv("FRONTEND_BASE_URL", raising=False)
    monkeypatch.delenv("DASHBOARD_WEB_BASE_URL", raising=False)
    monkeypatch.delenv("REPORT_WEB_BASE_URL", raising=False)
    monkeypatch.delenv("DASHBOARD_EXPORT_IMAGE_URL_TEMPLATE", raising=False)
    monkeypatch.delenv("REPORT_PAGE_SCREENSHOT_URL_TEMPLATE", raising=False)
    monkeypatch.setenv("REPORT_LINK_FALLBACK_ENABLED", "true")

    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Dashboard Default Image Project {uuid4().hex[:8]}",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    response = client.post(
        f"/api/reports/dashboard/v1/export-image?projectId={project_id}&timeRange=all&type=all&environment=all&model=all"
    )
    assert response.status_code == 200

    body = response.json()
    assert body["code"] == 0
    data = body["data"]
    assert data["reportPageUrl"].startswith("http://127.0.0.1:5173/reports/project?")
    assert "projectId=" in data["reportPageUrl"]
    assert data["screenshotUrl"].startswith("https://image.thum.io/get/width/1600/crop/900/noanimate/")
    assert "127.0.0.1%3A5173%2Freports%2Fproject%3F" in data["screenshotUrl"]


def test_suite_analytics_report_contains_deep_api_insights():
    client = TestClient(app)
    project_id, suite_id, environment_id = _create_suite_fixture(client)

    run_id_1 = _create_run_on_suite(client, project_id, suite_id, environment_id)
    run_id_2 = _create_run_on_suite(client, project_id, suite_id, environment_id)

    run_item_repo = TableRepository("run_item")
    run_repo = TableRepository("run_record")

    run_item_1 = run_item_repo.list({"run_id": run_id_1})[0]
    run_item_repo.update(
        run_item_1["id"],
        {
            "status": "success",
            "retry_count": 0,
            "duration_ms": 860,
            "error_info": None,
            "response_data": {"status_code": 200},
        },
    )

    run_repo.update(run_id_1, {"status": "success", "summary": {"total": 1, "passed": 1, "failed": 0}})

    run_item = run_item_repo.list({"run_id": run_id_2})[0]
    run_item_repo.update(
        run_item["id"],
        {
            "status": "failed",
            "retry_count": 2,
            "duration_ms": 4200,
            "error_info": {"type": "timeout_error", "message": "request timeout after 4s"},
            "response_data": {"status_code": 504},
        },
    )
    run_repo.update(run_id_2, {"status": "failed", "summary": {"total": 1, "passed": 0, "failed": 1}})

    response = client.get(f"/api/reports/suite/{suite_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0

    api_section = body["data"]["api"]
    assert isinstance(api_section["qualitySummary"], dict)
    assert api_section["qualitySummary"]["runCount"] >= 2
    assert api_section["qualitySummary"]["itemCount"] >= 2
    assert api_section["qualitySummary"]["retryHitCount"] >= 1
    assert api_section["qualitySummary"]["timeoutCount"] >= 1
    assert api_section["qualitySummary"]["slowRequestCount"] >= 1
    assert api_section["qualitySummary"]["flakyCaseCount"] >= 1

    assert isinstance(api_section["latestRunInsight"], dict)
    assert api_section["latestRunInsight"]["runId"] == run_id_2

    assert isinstance(api_section["statusCodeDistribution"], list)
    assert any(item["name"] == "504" and item["value"] >= 1 for item in api_section["statusCodeDistribution"])

    assert isinstance(api_section["topSlowCases"], list)
    assert len(api_section["topSlowCases"]) >= 1
    assert api_section["topSlowCases"][0]["sampleCount"] >= 2
    assert api_section["topSlowCases"][0]["avgDurationMs"] >= 2500
    assert api_section["topSlowCases"][0]["p95DurationMs"] >= 4000

    assert isinstance(api_section["flakyCases"], list)
    assert len(api_section["flakyCases"]) >= 1
