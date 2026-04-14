from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any
from urllib import request as urllib_request
from urllib.parse import unquote, urlencode, urlparse
from uuid import uuid4

from app.application.report_service import ReportService
from app.infrastructure.repositories.run_repository import RunRepository
from app.infrastructure.repositories.run_schedule_repository import RunScheduleRepository
from app.infrastructure.repositories.table_repository import TableRepository


TERMINAL_RUN_STATUSES = {"success", "failed", "partially_success", "canceled", "timeout"}
ALLOWED_REPORT_SUMMARY_SCOPES = {"project", "suite"}
SUPPORTED_REPORT_CHANNEL_TYPES = {"feishu_app"}
FEISHU_OPEN_API_BASE_URL = "https://open.feishu.cn"
MAX_FEISHU_TEXT_LENGTH = 18000
NETWORK_TIMEOUT_SECONDS = 12
LOCAL_REPORT_SCREENSHOT_ENABLED_ENV = "LOCAL_REPORT_SCREENSHOT_ENABLED"
LOCAL_REPORT_WEB_BASE_URL_ENV = "LOCAL_REPORT_WEB_BASE_URL"
LOCAL_REPORT_CAPTURE_PATH_ENV = "LOCAL_REPORT_CAPTURE_PATH"
LOCAL_SCREENSHOT_BROWSER_PATH_ENV = "LOCAL_SCREENSHOT_BROWSER_PATH"
LOCAL_SCREENSHOT_WINDOW_SIZE_ENV = "LOCAL_SCREENSHOT_WINDOW_SIZE"
LOCAL_SCREENSHOT_WINDOW_WIDTH_ENV = "LOCAL_SCREENSHOT_WINDOW_WIDTH"
LOCAL_SCREENSHOT_WINDOW_HEIGHT_ENV = "LOCAL_SCREENSHOT_WINDOW_HEIGHT"
LOCAL_SCREENSHOT_WINDOW_MAX_HEIGHT_ENV = "LOCAL_SCREENSHOT_WINDOW_MAX_HEIGHT"
LOCAL_SCREENSHOT_DEFAULT_WINDOW_WIDTH = 1600
LOCAL_SCREENSHOT_DEFAULT_WINDOW_HEIGHT = 3200
LOCAL_SCREENSHOT_DEFAULT_MAX_WINDOW_HEIGHT = 12000
LOCAL_SCREENSHOT_AUTO_HEIGHT_PADDING = 24
LOCAL_SCREENSHOT_TIMEOUT_SECONDS = 30


class ReportDeliveryService:
    def __init__(
        self,
        run_repository: RunRepository | None = None,
        schedule_repository: RunScheduleRepository | None = None,
        user_asset_repository: TableRepository | None = None,
        report_service: ReportService | None = None,
    ) -> None:
        self.run_repository = run_repository or RunRepository()
        self.schedule_repository = schedule_repository or RunScheduleRepository()
        self.user_asset_repository = user_asset_repository or TableRepository("user_asset")
        self.report_service = report_service or ReportService()

    def deliver_for_run(self, run_record: dict[str, Any]) -> dict[str, Any] | None:
        run_id = int(run_record.get("id") or 0)
        if run_id <= 0:
            return None
        status = str(run_record.get("status") or "").strip().lower()
        if status not in TERMINAL_RUN_STATUSES:
            return None
        source_id = run_record.get("source_id")
        if not isinstance(source_id, int):
            return None

        request_snapshot = run_record.get("request_snapshot") if isinstance(run_record.get("request_snapshot"), dict) else {}
        previous_delivery = request_snapshot.get("report_delivery") if isinstance(request_snapshot.get("report_delivery"), dict) else {}
        if previous_delivery.get("attempted_at"):
            return None

        schedule = self.schedule_repository.get(source_id)
        if schedule is None:
            return None
        schedule_meta = schedule.get("meta_info") if isinstance(schedule.get("meta_info"), dict) else {}
        delivery_config = schedule_meta.get("report_delivery") if isinstance(schedule_meta.get("report_delivery"), dict) else {}
        if not bool(delivery_config.get("enabled")):
            return None

        resolved_channel: dict[str, Any] | None = None
        report_payload: dict[str, Any] | None = None
        report_page_url: str | None = None
        screenshot_url: str | None = None
        delivery_status = "success"
        error_message: str | None = None
        try:
            resolved_channel = self._resolve_channel(delivery_config)
            if resolved_channel is None:
                return None
            report_page_url, screenshot_url = self._resolve_report_links(
                run_record=run_record,
                schedule=schedule,
                delivery_config=delivery_config,
            )
            report_payload = self._build_markdown_report(
                run_record=run_record,
                schedule=schedule,
                delivery_config=delivery_config,
                report_page_url=report_page_url,
                screenshot_url=screenshot_url,
            )
            content = self._build_message_text(
                run_record,
                schedule=schedule,
                report_payload=report_payload,
                report_page_url=report_page_url,
                screenshot_url=screenshot_url,
            )
            self._send_feishu_delivery(
                resolved_channel=resolved_channel,
                content=content,
                run_record=run_record,
                report_payload=report_payload,
                screenshot_url=screenshot_url,
            )
        except Exception as exc:  # noqa: BLE001
            delivery_status = "failed"
            error_message = str(exc)

        attempted_at = datetime.now(timezone.utc).isoformat()
        next_snapshot = dict(request_snapshot)
        next_snapshot["report_delivery"] = {
            "attempted_at": attempted_at,
            "status": delivery_status,
            "error": error_message,
            "channel_source": resolved_channel.get("channel_source") if isinstance(resolved_channel, dict) else None,
            "channel_asset_id": resolved_channel.get("channel_asset_id") if isinstance(resolved_channel, dict) else None,
            "summary_scope": report_payload.get("scope") if isinstance(report_payload, dict) else None,
            "summary_mode": report_payload.get("summary_mode") if isinstance(report_payload, dict) else None,
            "model": report_payload.get("model") if isinstance(report_payload, dict) else None,
            "llm_error": report_payload.get("llm_error") if isinstance(report_payload, dict) else None,
            "report_page_url": report_page_url,
            "report_page_screenshot_url": screenshot_url,
        }
        self.run_repository.update(run_id, {"request_snapshot": next_snapshot})

        return {
            "run_id": run_id,
            "status": delivery_status,
            "attempted_at": attempted_at,
            "error": error_message,
        }

    def _resolve_channel(self, delivery_config: dict[str, Any]) -> dict[str, Any] | None:
        channel_asset_id = delivery_config.get("channel_asset_id", delivery_config.get("channelAssetId"))
        if not isinstance(channel_asset_id, int):
            return None

        channel_asset = self.user_asset_repository.get(channel_asset_id)
        if channel_asset is None:
            raise ValueError(f"report channel asset {channel_asset_id} not found")
        if str(channel_asset.get("asset_type") or "") != "report_channel":
            raise ValueError("report channel asset_type must be report_channel")
        if str(channel_asset.get("status") or "active") != "active":
            raise ValueError("report channel must be active")

        content_json = channel_asset.get("content_json") if isinstance(channel_asset.get("content_json"), dict) else {}
        channel_type = str(content_json.get("channel_type") or "").strip() or "feishu_app"
        if channel_type not in SUPPORTED_REPORT_CHANNEL_TYPES:
            raise ValueError("report channel_type currently only supports feishu_app")

        self._validate_feishu_app_channel_fields(content_json)
        default_message = str(content_json.get("default_message") or "").strip() or None
        return {
            "channel_source": "asset",
            "channel_asset_id": channel_asset_id,
            "app_id": str(content_json.get("app_id") or "").strip(),
            "app_secret": str(content_json.get("app_secret") or "").strip(),
            "chat_id": str(content_json.get("chat_id") or "").strip(),
            "default_message": default_message,
        }

    @staticmethod
    def _validate_feishu_app_channel_fields(content_json: dict[str, Any]) -> None:
        app_id = str(content_json.get("app_id") or "").strip()
        app_secret = str(content_json.get("app_secret") or "").strip()
        chat_id = str(content_json.get("chat_id") or "").strip()
        if not app_id:
            raise ValueError("report channel app_id is required")
        if not app_secret:
            raise ValueError("report channel app_secret is required")
        if not chat_id:
            raise ValueError("report channel chat_id is required")

    def _build_markdown_report(
        self,
        *,
        run_record: dict[str, Any],
        schedule: dict[str, Any],
        delivery_config: dict[str, Any],
        report_page_url: str | None,
        screenshot_url: str | None,
    ) -> dict[str, Any]:
        run_project_id = int(run_record.get("project_id") or 0)
        schedule_project_id = int(schedule.get("project_id") or 0)
        project_id = run_project_id if run_project_id > 0 else schedule_project_id
        suite_id = schedule.get("suite_id")
        summary_scope = self._resolve_summary_scope(delivery_config=delivery_config, suite_id=suite_id)

        if summary_scope == "suite" and isinstance(suite_id, int):
            suite_report = self.report_service.export_suite_markdown_report(suite_id, recent_limit=None)
            markdown_content = self._append_scope_run_appendix(
                markdown_content=str(suite_report.get("markdownContent") or ""),
                summary_scope="suite",
                project_id=project_id if project_id > 0 else None,
                suite_id=suite_id,
            )
            return {
                "scope": "suite",
                "markdown_content": markdown_content,
                "summary_mode": suite_report.get("summaryMode"),
                "model": suite_report.get("model"),
                "llm_error": suite_report.get("llmError"),
                "generated_at": suite_report.get("generatedAt"),
            }

        if project_id <= 0:
            raise ValueError("project_id is required for project report delivery")
        dashboard_report = self.report_service.export_dashboard_v1_markdown_report(
            project_id=project_id,
            time_range="all",
            report_type="all",
            environment="all",
            model="all",
        )
        markdown_content = self._append_scope_run_appendix(
            markdown_content=str(dashboard_report.get("markdownContent") or ""),
            summary_scope="project",
            project_id=project_id,
            suite_id=None,
        )
        return {
            "scope": "project",
            "markdown_content": markdown_content,
            "summary_mode": dashboard_report.get("summaryMode"),
            "model": dashboard_report.get("model"),
            "llm_error": dashboard_report.get("llmError"),
            "generated_at": dashboard_report.get("generatedAt"),
        }

    def _append_scope_run_appendix(
        self,
        *,
        markdown_content: str,
        summary_scope: str,
        project_id: int | None,
        suite_id: int | None,
    ) -> str:
        appendix = self._build_scope_run_appendix(
            summary_scope=summary_scope,
            project_id=project_id,
            suite_id=suite_id,
        )
        base = markdown_content.strip()
        if not appendix:
            return base
        if not base:
            return appendix
        return f"{base}\n\n{appendix}"

    def _build_scope_run_appendix(
        self,
        *,
        summary_scope: str,
        project_id: int | None,
        suite_id: int | None,
    ) -> str:
        if not isinstance(project_id, int) or project_id <= 0:
            return ""

        if summary_scope == "suite" and isinstance(suite_id, int):
            runs = self.run_repository.list(project_id=project_id, suite_id=suite_id)
            scope_text = f"当前 Suite（suite_id={suite_id}）"
        else:
            runs = self.run_repository.list(project_id=project_id)
            scope_text = "当前项目"

        supported_runs = [
            run
            for run in runs
            if self._normalize_run_type(run.get("run_type")) in {"api_test", "agent_eval"}
        ]
        supported_runs.sort(key=lambda item: int(item.get("id") or 0), reverse=True)

        lines = [
            "## 附录：API/Benchmark 全量运行明细",
            "",
            f"- 统计范围：{scope_text}",
            f"- 统计数量：{len(supported_runs)} 个运行",
            "",
        ]

        if not supported_runs:
            lines.append("当前范围内暂无 API/Benchmark 运行记录。")
            return "\n".join(lines).strip()

        lines.extend(
            [
                "| Run ID | 类型 | 状态 | Suite | 总数 | 通过 | 失败 | 通过率 | 创建时间 |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for run in supported_runs:
            summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
            total = int(summary.get("total") or 0)
            passed = int(summary.get("passed") or 0)
            failed = int(summary.get("failed") or 0)
            pass_rate = self._run_pass_rate(total=total, passed=passed)
            run_id = int(run.get("id") or 0)
            run_type = self._normalize_run_type(run.get("run_type"))
            run_type_label = "benchmark" if run_type == "agent_eval" else "api_test"
            status = str(run.get("status") or "-")
            suite_value = run.get("suite_id")
            suite_text = str(suite_value) if isinstance(suite_value, int) else "-"
            created_at = str(run.get("created_at") or "-")
            lines.append(
                f"| {run_id} | {run_type_label} | {status} | {suite_text} | {total} | {passed} | {failed} | {pass_rate} | {created_at} |"
            )
        return "\n".join(lines).strip()

    @staticmethod
    def _append_report_page_screenshot_section(
        *,
        markdown_content: str,
        report_page_url: str | None,
        screenshot_url: str | None,
    ) -> str:
        lines: list[str] = []
        lines.extend(
            [
                "## 项目报告页面截图",
                "",
            ]
        )
        if screenshot_url:
            lines.append(f"![项目报告页面截图]({screenshot_url})")
            lines.append("")
            lines.append(f"- 原始截图地址：{screenshot_url}")
        elif report_page_url:
            lines.append("当前未生成截图，点击页面链接查看最新项目报告：")
            lines.append("")
            lines.append(f"- {report_page_url}")
        else:
            lines.append("未配置项目报告页面地址，当前无法附加截图。")
        content = markdown_content.strip()
        if content:
            lines.append("")
            lines.append(content)
        return "\n".join(lines).strip()

    @staticmethod
    def _run_pass_rate(*, total: int, passed: int) -> str:
        if total <= 0:
            return "0.00%"
        return f"{(passed / total) * 100:.2f}%"

    @staticmethod
    def _normalize_run_type(run_type: Any) -> str:
        normalized = str(run_type or "").strip()
        if normalized == "benchmark":
            return "agent_eval"
        return normalized

    @staticmethod
    def _resolve_summary_scope(*, delivery_config: dict[str, Any], suite_id: Any) -> str:
        raw_scope = delivery_config.get("summary_scope", delivery_config.get("summaryScope"))
        if isinstance(raw_scope, str):
            normalized = raw_scope.strip().lower()
            if normalized in ALLOWED_REPORT_SUMMARY_SCOPES:
                if normalized == "suite" and not isinstance(suite_id, int):
                    return "project"
                return normalized
        return "suite" if isinstance(suite_id, int) else "project"

    def _resolve_report_links(
        self,
        *,
        run_record: dict[str, Any],
        schedule: dict[str, Any],
        delivery_config: dict[str, Any],
    ) -> tuple[str | None, str | None]:
        include_screenshot = bool(
            delivery_config.get(
                "include_report_page_screenshot",
                delivery_config.get("includeReportPageScreenshot", True),
            )
        )
        run_project_id = int(run_record.get("project_id") or 0)
        schedule_project_id = int(schedule.get("project_id") or 0)
        project_id = run_project_id if run_project_id > 0 else schedule_project_id
        if project_id <= 0:
            return None, None
        image_export = self.report_service.export_dashboard_v1_image(
            project_id=project_id,
            time_range="all",
            report_type="all",
            environment="all",
            model="all",
        )
        report_page_url = str(image_export.get("reportPageUrl") or "").strip() or None
        if not include_screenshot:
            return report_page_url, None
        screenshot_url = str(image_export.get("screenshotUrl") or "").strip() or None

        local_screenshot_enabled = self._is_local_report_screenshot_enabled()
        if local_screenshot_enabled:
            local_report_page_url = report_page_url
            if not local_report_page_url:
                local_report_page_url = self._build_local_report_page_url(
                    project_id=project_id,
                    time_range="all",
                    report_type="all",
                    environment="all",
                    model="all",
                )
            prefer_local_capture = self._is_local_web_url(local_report_page_url)
            if prefer_local_capture or not screenshot_url:
                local_screenshot_url = self._capture_local_report_page_screenshot(
                    run_record=run_record,
                    report_page_url=local_report_page_url,
                )
                if local_screenshot_url:
                    return local_report_page_url, local_screenshot_url

        return report_page_url, screenshot_url

    def _build_message_text(
        self,
        run_record: dict[str, Any],
        *,
        schedule: dict[str, Any],
        report_payload: dict[str, Any],
        report_page_url: str | None,
        screenshot_url: str | None,
    ) -> str:
        summary = run_record.get("summary") if isinstance(run_record.get("summary"), dict) else {}
        total = int(summary.get("total") or 0)
        passed = int(summary.get("passed") or 0)
        failed = int(summary.get("failed") or 0)
        status = str(run_record.get("status") or "-")
        run_type = str(run_record.get("run_type") or "-")
        run_id = int(run_record.get("id") or 0)
        schedule_name = str(schedule.get("name") or f"schedule-{schedule.get('id')}")
        pass_rate_text = self._run_pass_rate(total=total, passed=passed)

        lines = [
            "【定时任务测评报告摘要】",
            f"任务：{schedule_name}",
            f"Run：#{run_id}",
            f"状态：{status}",
            f"类型：{run_type}",
            f"结果：总计 {total} / 通过 {passed} / 失败 {failed}",
            f"通过率：{pass_rate_text}",
            f"报告范围：{'当前 Suite' if report_payload.get('scope') == 'suite' else '当前项目'}",
            "附加说明：详细测试报告文档将作为文件发送。",
        ]
        avg_score = summary.get("avg_score")
        if isinstance(avg_score, (int, float)):
            lines.append(f"平均分：{round(float(avg_score), 4)}")
        lines.append("")
        lines.append("【报告文档】")
        lines.append("已附《总结测试报告》文档，请在群消息中查看附件。")
        return self._trim_feishu_text("\n".join(lines))

    @staticmethod
    def _trim_feishu_text(content: str) -> str:
        text = content.strip()
        if len(text) <= MAX_FEISHU_TEXT_LENGTH:
            return text
        tail = "\n\n（报告内容过长，已截断。请前往平台查看完整报告。）"
        limit = max(1, MAX_FEISHU_TEXT_LENGTH - len(tail))
        return text[:limit] + tail

    def _send_feishu_delivery(
        self,
        *,
        resolved_channel: dict[str, Any],
        content: str,
        run_record: dict[str, Any],
        report_payload: dict[str, Any],
        screenshot_url: str | None,
    ) -> None:
        app_id = str(resolved_channel.get("app_id") or "").strip()
        app_secret = str(resolved_channel.get("app_secret") or "").strip()
        chat_id = str(resolved_channel.get("chat_id") or "").strip()
        if not app_id or not app_secret or not chat_id:
            raise ValueError("report channel credentials are incomplete")

        tenant_access_token = self._fetch_tenant_access_token(app_id=app_id, app_secret=app_secret)
        screenshot_delivery_error: str | None = None
        if screenshot_url:
            try:
                image_bytes, image_content_type = self._download_remote_binary(screenshot_url)
                image_file_name = self._build_image_file_name(
                    run_record=run_record,
                    content_type=image_content_type,
                )
                image_key = self._upload_feishu_image(
                    tenant_access_token=tenant_access_token,
                    image_file_name=image_file_name,
                    image_bytes=image_bytes,
                    image_content_type=image_content_type,
                )
                self._send_feishu_message(
                    tenant_access_token=tenant_access_token,
                    chat_id=chat_id,
                    msg_type="image",
                    content={"image_key": image_key},
                )
            except Exception as exc:  # noqa: BLE001
                screenshot_delivery_error = str(exc)

        self._send_feishu_message(
            tenant_access_token=tenant_access_token,
            chat_id=chat_id,
            msg_type="text",
            content={"text": content},
        )
        if screenshot_delivery_error and screenshot_url:
            self._send_feishu_message(
                tenant_access_token=tenant_access_token,
                chat_id=chat_id,
                msg_type="text",
                content={"text": f"项目报告截图上传失败，可直接访问截图地址：{screenshot_url}；错误：{screenshot_delivery_error}"},
            )

        markdown_content = str(report_payload.get("markdown_content") or "").strip()
        if markdown_content:
            file_name = self._build_report_file_name(run_record=run_record, report_payload=report_payload)
            file_key = self._upload_feishu_file(
                tenant_access_token=tenant_access_token,
                file_name=file_name,
                file_bytes=markdown_content.encode("utf-8"),
            )
            self._send_feishu_message(
                tenant_access_token=tenant_access_token,
                chat_id=chat_id,
                msg_type="file",
                content={"file_key": file_key},
            )

    @staticmethod
    def _build_report_file_name(*, run_record: dict[str, Any], report_payload: dict[str, Any]) -> str:
        run_id = int(run_record.get("id") or 0)
        scope = str(report_payload.get("scope") or "report").strip().lower() or "report"
        generated_at = str(report_payload.get("generated_at") or datetime.now(timezone.utc).isoformat())
        timestamp = generated_at.replace(":", "-").replace(".", "-")
        return f"run-{run_id}-{scope}-report-{timestamp}.md"

    @staticmethod
    def _build_image_file_name(*, run_record: dict[str, Any], content_type: str) -> str:
        run_id = int(run_record.get("id") or 0)
        ext = "png"
        normalized = content_type.strip().lower()
        if normalized == "image/jpeg":
            ext = "jpg"
        elif normalized == "image/webp":
            ext = "webp"
        elif normalized == "image/gif":
            ext = "gif"
        return f"run-{run_id}-report-screenshot.{ext}"

    def _fetch_tenant_access_token(self, *, app_id: str, app_secret: str) -> str:
        url = f"{self._feishu_open_api_base_url()}/open-apis/auth/v3/tenant_access_token/internal/"
        response = self._post_json(
            url,
            payload={
                "app_id": app_id,
                "app_secret": app_secret,
            },
            error_prefix="feishu auth failed",
        )
        token = str(response.get("tenant_access_token") or "").strip()
        if not token:
            data = response.get("data") if isinstance(response.get("data"), dict) else {}
            token = str(data.get("tenant_access_token") or "").strip()
        if not token:
            raise ValueError("feishu auth failed: tenant_access_token is empty")
        return token

    def _send_feishu_message(
        self,
        *,
        tenant_access_token: str,
        chat_id: str,
        msg_type: str,
        content: dict[str, Any],
    ) -> None:
        url = f"{self._feishu_open_api_base_url()}/open-apis/im/v1/messages?receive_id_type=chat_id"
        self._post_json(
            url,
            payload={
                "receive_id": chat_id,
                "msg_type": msg_type,
                "content": json.dumps(content, ensure_ascii=False),
            },
            headers={"Authorization": f"Bearer {tenant_access_token}"},
            error_prefix="feishu send message failed",
        )

    def _upload_feishu_file(self, *, tenant_access_token: str, file_name: str, file_bytes: bytes) -> str:
        url = f"{self._feishu_open_api_base_url()}/open-apis/im/v1/files"
        body, boundary = self._build_multipart_form_data(
            fields={
                "file_type": "stream",
                "file_name": file_name,
            },
            file_field_name="file",
            file_name=file_name,
            file_bytes=file_bytes,
            file_content_type="text/markdown",
        )
        response = self._post_bytes_and_parse_json(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {tenant_access_token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            error_prefix="feishu upload file failed",
        )
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        file_key = str(data.get("file_key") or "").strip()
        if not file_key:
            raise ValueError("feishu upload file failed: file_key is empty")
        return file_key

    def _upload_feishu_image(
        self,
        *,
        tenant_access_token: str,
        image_file_name: str,
        image_bytes: bytes,
        image_content_type: str,
    ) -> str:
        url = f"{self._feishu_open_api_base_url()}/open-apis/im/v1/images"
        body, boundary = self._build_multipart_form_data(
            fields={"image_type": "message"},
            file_field_name="image",
            file_name=image_file_name,
            file_bytes=image_bytes,
            file_content_type=image_content_type,
        )
        response = self._post_bytes_and_parse_json(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {tenant_access_token}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            error_prefix="feishu upload image failed",
        )
        data = response.get("data") if isinstance(response.get("data"), dict) else {}
        image_key = str(data.get("image_key") or "").strip()
        if not image_key:
            raise ValueError("feishu upload image failed: image_key is empty")
        return image_key

    @staticmethod
    def _build_multipart_form_data(
        *,
        fields: dict[str, str],
        file_field_name: str,
        file_name: str,
        file_bytes: bytes,
        file_content_type: str,
    ) -> tuple[bytes, str]:
        boundary = f"----NeptuneBoundary{uuid4().hex}"
        chunks: list[bytes] = []

        for key, value in fields.items():
            chunks.append(f"--{boundary}\r\n".encode("utf-8"))
            chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
            chunks.append(str(value).encode("utf-8"))
            chunks.append(b"\r\n")

        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{file_field_name}"; filename="{file_name}"\r\n'.encode("utf-8")
        )
        chunks.append(f"Content-Type: {file_content_type}\r\n\r\n".encode("utf-8"))
        chunks.append(file_bytes)
        chunks.append(b"\r\n")
        chunks.append(f"--{boundary}--\r\n".encode("utf-8"))

        return b"".join(chunks), boundary

    def _download_remote_binary(self, url: str) -> tuple[bytes, str]:
        if url.startswith("file://"):
            parsed = urlparse(url)
            local_path = Path(unquote(parsed.path))
            if not local_path.exists():
                raise ValueError(f"download remote binary failed: file not found ({local_path})")
            raw = local_path.read_bytes()
            if not raw:
                raise ValueError("download remote binary failed: empty body")
            suffix = local_path.suffix.strip().lower()
            if suffix in {".jpg", ".jpeg"}:
                return raw, "image/jpeg"
            if suffix == ".webp":
                return raw, "image/webp"
            if suffix == ".gif":
                return raw, "image/gif"
            return raw, "image/png"

        req = urllib_request.Request(url, method="GET")
        with urllib_request.urlopen(req, timeout=NETWORK_TIMEOUT_SECONDS) as response:
            raw = response.read()
            content_type = str(response.headers.get("Content-Type") or "application/octet-stream")
        if not raw:
            raise ValueError("download remote binary failed: empty body")

        normalized_content_type = content_type.split(";", 1)[0].strip().lower() or "application/octet-stream"
        if not normalized_content_type.startswith("image/"):
            normalized_content_type = "image/png"
        return raw, normalized_content_type

    @staticmethod
    def _is_local_report_screenshot_enabled() -> bool:
        raw = os.getenv(LOCAL_REPORT_SCREENSHOT_ENABLED_ENV, "true").strip().lower()
        return raw not in {"0", "false", "off", "no"}

    @staticmethod
    def _build_local_report_page_url(
        *,
        project_id: int,
        time_range: str,
        report_type: str,
        environment: str,
        model: str,
    ) -> str | None:
        base = os.getenv(LOCAL_REPORT_WEB_BASE_URL_ENV, "http://localhost:5173").strip()
        if not base:
            return None
        report_path = os.getenv(LOCAL_REPORT_CAPTURE_PATH_ENV, "/reports/project-capture").strip() or "/reports/project-capture"
        if not report_path.startswith("/"):
            report_path = f"/{report_path}"
        query: dict[str, str | int] = {
            "timeRange": time_range,
            "type": report_type,
            "environment": environment,
            "model": model,
            "projectId": project_id,
        }
        return f"{base.rstrip('/')}{report_path}?{urlencode(query)}"

    @staticmethod
    def _is_local_web_url(url: str | None) -> bool:
        if not url:
            return False
        try:
            parsed = urlparse(url)
        except Exception:  # noqa: BLE001
            return False
        host = (parsed.hostname or "").strip().lower()
        return host in {"localhost", "127.0.0.1", "0.0.0.0"}

    def _capture_local_report_page_screenshot(
        self,
        *,
        run_record: dict[str, Any],
        report_page_url: str | None,
    ) -> str | None:
        if not self._is_local_web_url(report_page_url):
            return None
        browser_path = self._resolve_local_screenshot_browser()
        if not browser_path:
            return None

        runtime_dir = Path(__file__).resolve().parents[2] / ".runtime" / "reports" / "screenshots"
        runtime_dir.mkdir(parents=True, exist_ok=True)
        output_path = runtime_dir / self._build_image_file_name(run_record=run_record, content_type="image/png")
        base_window_width, base_window_height = self._resolve_local_screenshot_window_dimensions()
        max_window_height = self._resolve_local_screenshot_max_height()
        estimated_height = self._estimate_local_report_page_height(
            browser_path=browser_path,
            report_page_url=report_page_url,
            window_width=base_window_width,
            window_height=base_window_height,
        )
        if isinstance(estimated_height, int) and estimated_height > 0:
            base_window_height = min(max_window_height, max(900, estimated_height + LOCAL_SCREENSHOT_AUTO_HEIGHT_PADDING))
        window_size = f"{base_window_width},{base_window_height}"
        cmd = [
            browser_path,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            f"--window-size={window_size}",
            "--virtual-time-budget=15000",
            f"--screenshot={str(output_path)}",
            str(report_page_url),
        ]
        try:
            subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                timeout=LOCAL_SCREENSHOT_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001
            return None
        if not output_path.exists() or output_path.stat().st_size <= 0:
            return None
        return output_path.resolve().as_uri()

    @staticmethod
    def _resolve_local_screenshot_browser() -> str | None:
        configured = os.getenv(LOCAL_SCREENSHOT_BROWSER_PATH_ENV, "").strip()
        candidates = [
            configured,
            shutil.which("google-chrome") or "",
            shutil.which("chromium-browser") or "",
            shutil.which("chromium") or "",
            shutil.which("chrome") or "",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
        for candidate in candidates:
            value = candidate.strip()
            if not value:
                continue
            if Path(value).exists() and os.access(value, os.X_OK):
                return value
        return None

    @staticmethod
    def _resolve_local_screenshot_window_size() -> str:
        width_value, height_value = ReportDeliveryService._resolve_local_screenshot_window_dimensions()
        return f"{width_value},{height_value}"

    @staticmethod
    def _resolve_local_screenshot_window_dimensions() -> tuple[int, int]:
        raw = os.getenv(LOCAL_SCREENSHOT_WINDOW_SIZE_ENV, "").strip()
        if raw and "," in raw:
            width_raw, height_raw = raw.split(",", 1)
            try:
                width_value = max(800, int(width_raw.strip()))
                height_value = max(900, int(height_raw.strip()))
                return width_value, height_value
            except ValueError:
                pass

        width_raw = os.getenv(LOCAL_SCREENSHOT_WINDOW_WIDTH_ENV, "").strip()
        height_raw = os.getenv(LOCAL_SCREENSHOT_WINDOW_HEIGHT_ENV, "").strip()
        try:
            width_value = max(800, int(width_raw)) if width_raw else LOCAL_SCREENSHOT_DEFAULT_WINDOW_WIDTH
        except ValueError:
            width_value = LOCAL_SCREENSHOT_DEFAULT_WINDOW_WIDTH
        try:
            height_value = max(900, int(height_raw)) if height_raw else LOCAL_SCREENSHOT_DEFAULT_WINDOW_HEIGHT
        except ValueError:
            height_value = LOCAL_SCREENSHOT_DEFAULT_WINDOW_HEIGHT
        return width_value, height_value

    @staticmethod
    def _resolve_local_screenshot_max_height() -> int:
        raw = os.getenv(LOCAL_SCREENSHOT_WINDOW_MAX_HEIGHT_ENV, "").strip()
        if not raw:
            return LOCAL_SCREENSHOT_DEFAULT_MAX_WINDOW_HEIGHT
        try:
            value = int(raw)
        except ValueError:
            return LOCAL_SCREENSHOT_DEFAULT_MAX_WINDOW_HEIGHT
        return max(1200, value)

    def _estimate_local_report_page_height(
        self,
        *,
        browser_path: str,
        report_page_url: str | None,
        window_width: int,
        window_height: int,
    ) -> int | None:
        if not self._is_local_web_url(report_page_url):
            return None
        effective_width = max(800, int(window_width or 0))
        effective_height = max(900, int(window_height or 0))
        cmd = [
            browser_path,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            f"--window-size={effective_width},{effective_height}",
            "--virtual-time-budget=15000",
            "--dump-dom",
            str(report_page_url),
        ]
        try:
            result = subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                timeout=LOCAL_SCREENSHOT_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001
            return None
        dom = str(result.stdout or "")
        if not dom:
            return None
        match = re.search(r'data-report-page-height="(\d+)"', dom)
        if not match:
            return None
        try:
            value = int(match.group(1))
        except ValueError:
            return None
        if value <= 0:
            return None
        return value

    def _post_json(
        self,
        url: str,
        *,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
        error_prefix: str,
    ) -> dict[str, Any]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        merged_headers = {"Content-Type": "application/json; charset=utf-8"}
        if headers:
            merged_headers.update(headers)
        return self._post_bytes_and_parse_json(
            url,
            data=data,
            headers=merged_headers,
            error_prefix=error_prefix,
        )

    def _post_bytes_and_parse_json(
        self,
        url: str,
        *,
        data: bytes,
        headers: dict[str, str],
        error_prefix: str,
    ) -> dict[str, Any]:
        req = urllib_request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(req, timeout=NETWORK_TIMEOUT_SECONDS) as response:
                raw = response.read()
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{error_prefix}: {exc}") from exc

        if not raw:
            raise ValueError(f"{error_prefix}: empty response")
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{error_prefix}: invalid json response") from exc
        if not isinstance(parsed, dict):
            raise ValueError(f"{error_prefix}: invalid response payload")

        code = parsed.get("code")
        if isinstance(code, int) and code != 0:
            raise ValueError(f"{error_prefix}: {parsed.get('msg') or 'unknown error'}")
        return parsed

    @staticmethod
    def _feishu_open_api_base_url() -> str:
        configured = os.getenv("FEISHU_OPEN_BASE_URL", "").strip()
        return (configured or FEISHU_OPEN_API_BASE_URL).rstrip("/")
