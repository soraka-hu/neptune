from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.application.report_delivery_service import ReportDeliveryService
from app.application.report_service import ReportService
from app.application.run_service import RunService
from app.infrastructure.repositories.run_repository import RunRepository
from app.main import app


def test_validate_feishu_app_channel_fields():
    ReportDeliveryService._validate_feishu_app_channel_fields(
        {
            "app_id": "cli_test",
            "app_secret": "secret_test",
            "chat_id": "oc_test",
        }
    )

    with pytest.raises(ValueError, match="report channel app_id is required"):
        ReportDeliveryService._validate_feishu_app_channel_fields({"app_secret": "x", "chat_id": "oc_x"})
    with pytest.raises(ValueError, match="report channel app_secret is required"):
        ReportDeliveryService._validate_feishu_app_channel_fields({"app_id": "cli_x", "chat_id": "oc_x"})
    with pytest.raises(ValueError, match="report channel chat_id is required"):
        ReportDeliveryService._validate_feishu_app_channel_fields({"app_id": "cli_x", "app_secret": "x"})


def test_report_delivery_uses_asset_channel_and_only_attempts_once(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_ENABLED", "false")
    monkeypatch.setenv("NEPTUNE_WEB_BASE_URL", "https://neptune.example.com")
    monkeypatch.setenv(
        "DASHBOARD_EXPORT_IMAGE_URL_TEMPLATE",
        "https://img.example.com/capture?project={project_id}&timeRange={time_range}&type={report_type}&environment={environment}&model={model}&url={project_report_url_encoded}",
    )
    sent_requests: list[dict[str, Any]] = []

    def fake_send_feishu_delivery(
        *,
        resolved_channel: dict[str, Any],
        content: str,
        run_record: dict[str, Any],
        report_payload: dict[str, Any],
        screenshot_url: str | None,
    ):
        sent_requests.append(
            {
                "channel": resolved_channel,
                "content": content,
                "run_id": run_record.get("id"),
                "report_scope": report_payload.get("scope"),
                "markdown_content": report_payload.get("markdown_content"),
                "screenshot_url": screenshot_url,
            }
        )

    monkeypatch.setattr(ReportDeliveryService, "_send_feishu_delivery", staticmethod(fake_send_feishu_delivery))

    def fake_export_suite_markdown_report(self, suite_id: int, *, recent_limit: int | None = 10):
        return {
            "suiteId": suite_id,
            "suiteName": "Delivery Suite",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "fileName": "suite-report.md",
            "markdownContent": "## Suite 报告\n- API Case: 1\n- Benchmark: 0",
            "summaryMode": "llm",
            "model": "mock-model",
            "llmError": None,
        }

    monkeypatch.setattr(
        ReportService,
        "export_suite_markdown_report",
        fake_export_suite_markdown_report,
    )

    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": f"Delivery Project {uuid4().hex[:6]}",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Delivery Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Delivery Env",
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
            "name": "Delivery API Case",
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

    channel_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "report_channel",
            "name": "Asset Channel",
            "contentJson": {
                "channel_type": "feishu_app",
                "app_id": "cli_asset_channel",
                "app_secret": "secret_asset_channel",
                "chat_id": "oc_asset_channel",
                "default_message": "asset message",
            },
        },
    )
    assert channel_response.status_code == 200
    channel_id = channel_response.json()["data"]["id"]

    schedule_response = client.post(
        "/api/run-schedules",
        json={
            "name": "delivery schedule",
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
        },
    )
    assert schedule_response.status_code == 200
    schedule_id = schedule_response.json()["data"]["id"]

    trigger_response = client.post(f"/api/run-schedules/{schedule_id}/trigger", json={})
    assert trigger_response.status_code == 200
    run_id = trigger_response.json()["data"]["run"]["id"]

    RunRepository().update(
        run_id,
        {
            "status": "success",
            "summary": {"total": 1, "passed": 1, "failed": 0},
            "finished_at": datetime.now(timezone.utc),
        },
    )
    run_record = RunRepository().get(run_id)
    assert run_record is not None

    result = ReportDeliveryService().deliver_for_run(run_record)
    assert result is not None
    assert result["status"] == "success"
    assert len(sent_requests) == 1
    channel = sent_requests[0]["channel"]
    assert isinstance(channel, dict)
    assert channel.get("app_id") == "cli_asset_channel"
    assert channel.get("chat_id") == "oc_asset_channel"
    assert "nightly report" not in sent_requests[0]["content"]
    assert "定时任务测评报告摘要" in sent_requests[0]["content"]
    assert "报告文档" in sent_requests[0]["content"]
    assert "项目报告页面截图" not in sent_requests[0]["content"]
    assert "总结生成方式" not in sent_requests[0]["content"]
    assert "模型：" not in sent_requests[0]["content"]
    assert "img.example.com/capture" in str(sent_requests[0]["screenshot_url"])
    assert "project=" in str(sent_requests[0]["screenshot_url"])
    assert "timeRange=all" in str(sent_requests[0]["screenshot_url"])
    markdown_content = str(sent_requests[0]["markdown_content"] or "")
    assert markdown_content.startswith("## Suite 报告")
    assert "附录：API/Benchmark 全量运行明细" in markdown_content
    assert "| Run ID | 类型 | 状态 | Suite |" in markdown_content
    assert "项目报告页面截图" not in markdown_content

    refreshed_run = RunRepository().get(run_id)
    assert refreshed_run is not None
    tracking = refreshed_run.get("request_snapshot", {}).get("report_delivery", {})
    assert tracking.get("status") == "success"
    assert tracking.get("attempted_at")
    assert tracking.get("summary_scope") == "suite"
    assert tracking.get("summary_mode") == "llm"
    assert isinstance(tracking.get("report_page_screenshot_url"), str)

    run_detail = RunService().get_run(run_id)
    assert run_detail.get("report_delivery_status") == "success"
    assert run_detail.get("report_delivery_error") is None

    duplicate_attempt = ReportDeliveryService().deliver_for_run(refreshed_run)
    assert duplicate_attempt is None
    assert len(sent_requests) == 1


def test_send_feishu_delivery_uploads_screenshot_and_keeps_report_content(monkeypatch):
    sent_messages: list[tuple[str, dict[str, Any]]] = []
    uploaded_markdown: list[str] = []

    def fake_fetch_tenant_access_token(self, *, app_id: str, app_secret: str) -> str:
        assert app_id == "cli_test"
        assert app_secret == "secret_test"
        return "token_test"

    def fake_download_remote_binary(self, url: str) -> tuple[bytes, str]:
        assert url == "https://img.example.com/capture?project=1"
        return (b"\x89PNG\r\n\x1a\nmock", "image/png")

    def fake_upload_feishu_image(
        self,
        *,
        tenant_access_token: str,
        image_file_name: str,
        image_bytes: bytes,
        image_content_type: str,
    ) -> str:
        assert tenant_access_token == "token_test"
        assert image_file_name.startswith("run-9527-report-screenshot")
        assert image_bytes.startswith(b"\x89PNG")
        assert image_content_type == "image/png"
        return "img_v3_123"

    def fake_send_feishu_message(
        self,
        *,
        tenant_access_token: str,
        chat_id: str,
        msg_type: str,
        content: dict[str, Any],
    ) -> None:
        assert tenant_access_token == "token_test"
        assert chat_id == "oc_test"
        sent_messages.append((msg_type, content))

    def fake_upload_feishu_file(self, *, tenant_access_token: str, file_name: str, file_bytes: bytes) -> str:
        assert tenant_access_token == "token_test"
        assert file_name.startswith("run-9527-project-report-")
        uploaded_markdown.append(file_bytes.decode("utf-8"))
        return "file_v3_456"

    monkeypatch.setattr(ReportDeliveryService, "_fetch_tenant_access_token", fake_fetch_tenant_access_token)
    monkeypatch.setattr(ReportDeliveryService, "_download_remote_binary", fake_download_remote_binary)
    monkeypatch.setattr(ReportDeliveryService, "_upload_feishu_image", fake_upload_feishu_image)
    monkeypatch.setattr(ReportDeliveryService, "_send_feishu_message", fake_send_feishu_message)
    monkeypatch.setattr(ReportDeliveryService, "_upload_feishu_file", fake_upload_feishu_file)

    service = ReportDeliveryService()
    service._send_feishu_delivery(
        resolved_channel={
            "app_id": "cli_test",
            "app_secret": "secret_test",
            "chat_id": "oc_test",
        },
        content="summary text",
        run_record={"id": 9527},
        report_payload={
            "scope": "project",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "markdown_content": "## 报告正文\n- 这是测试报告正文",
        },
        screenshot_url="https://img.example.com/capture?project=1",
    )

    assert uploaded_markdown
    markdown = uploaded_markdown[0]
    assert markdown == "## 报告正文\n- 这是测试报告正文"
    assert any(msg_type == "image" for msg_type, _ in sent_messages)
    assert any(msg_type == "file" for msg_type, _ in sent_messages)


def test_resolve_report_links_uses_local_capture_when_remote_missing(monkeypatch):
    class _FakeReportService:
        def export_dashboard_v1_image(self, **kwargs: Any) -> dict[str, Any]:
            return {"reportPageUrl": None, "screenshotUrl": None}

    service = ReportDeliveryService(report_service=_FakeReportService())
    monkeypatch.setattr(
        ReportDeliveryService,
        "_is_local_report_screenshot_enabled",
        staticmethod(lambda: True),
    )

    def fake_capture_local(
        self,
        *,
        run_record: dict[str, Any],
        report_page_url: str | None,
    ) -> str | None:
        assert int(run_record.get("project_id") or 0) == 411
        assert isinstance(report_page_url, str)
        assert report_page_url.startswith("http://localhost:5173/reports/project-capture?")
        return "file:///tmp/run-249-report-screenshot.png"

    monkeypatch.setattr(ReportDeliveryService, "_capture_local_report_page_screenshot", fake_capture_local)

    report_page_url, screenshot_url = service._resolve_report_links(
        run_record={"project_id": 411},
        schedule={"project_id": 411},
        delivery_config={"include_report_page_screenshot": True},
    )

    assert isinstance(report_page_url, str)
    assert report_page_url.startswith("http://localhost:5173/reports/project-capture?")
    assert screenshot_url == "file:///tmp/run-249-report-screenshot.png"


def test_build_message_text_excludes_screenshot_block():
    service = ReportDeliveryService()
    content = service._build_message_text(
        {
            "id": 9527,
            "status": "success",
            "run_type": "api_test",
            "summary": {"total": 4, "passed": 4, "failed": 0},
        },
        schedule={"id": 36, "name": "daily schedule"},
        report_payload={"scope": "project"},
        report_page_url="http://localhost:5173/reports/project?projectId=411",
        screenshot_url="file:///tmp/run-9527-report-screenshot.png",
    )
    assert "项目报告页面截图" not in content
    assert "项目报告页面链接" not in content
    assert "file:///tmp/run-9527-report-screenshot.png" not in content


def test_resolve_local_screenshot_window_size_prefers_combined_env(monkeypatch):
    monkeypatch.setenv("LOCAL_SCREENSHOT_WINDOW_SIZE", "1800,4200")
    monkeypatch.setenv("LOCAL_SCREENSHOT_WINDOW_WIDTH", "1200")
    monkeypatch.setenv("LOCAL_SCREENSHOT_WINDOW_HEIGHT", "2200")
    value = ReportDeliveryService._resolve_local_screenshot_window_size()
    assert value == "1800,4200"


def test_resolve_local_screenshot_window_size_supports_split_env(monkeypatch):
    monkeypatch.delenv("LOCAL_SCREENSHOT_WINDOW_SIZE", raising=False)
    monkeypatch.setenv("LOCAL_SCREENSHOT_WINDOW_WIDTH", "1700")
    monkeypatch.setenv("LOCAL_SCREENSHOT_WINDOW_HEIGHT", "3500")
    value = ReportDeliveryService._resolve_local_screenshot_window_size()
    assert value == "1700,3500"


def test_estimate_local_report_page_height_reads_dom_marker(monkeypatch):
    service = ReportDeliveryService()

    def fake_run(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["chrome"],
            returncode=0,
            stdout='<html data-report-page-height="4123"><body></body></html>',
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    value = service._estimate_local_report_page_height(
        browser_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        report_page_url="http://localhost:5173/reports/project?projectId=411",
        window_width=1600,
        window_height=3200,
    )
    assert value == 4123
