from __future__ import annotations

from datetime import date, datetime
import math
import os
from typing import Any
from urllib.parse import quote, urlencode

from app.application.project_service import NotFoundError
from app.infrastructure.llm.model_gateway_client import ModelGatewayClient
from app.infrastructure.repositories.project_repository import ProjectRepository
from app.infrastructure.repositories.run_repository import RunRepository
from app.infrastructure.repositories.suite_repository import SuiteRepository
from app.infrastructure.repositories.table_repository import TableRepository


DEFAULT_DASHBOARD_WEB_BASE_URL = "http://127.0.0.1:5173"
DEFAULT_DASHBOARD_SCREENSHOT_URL_TEMPLATE = (
    "https://image.thum.io/get/width/1600/crop/900/noanimate/{report_page_url_encoded}"
)
REPORT_LINK_FALLBACK_ENABLED_ENV = "REPORT_LINK_FALLBACK_ENABLED"


class ReportService:
    def __init__(
        self,
        run_repository: RunRepository | None = None,
        run_item_repository: TableRepository | None = None,
        environment_repository: TableRepository | None = None,
        judge_record_repository: TableRepository | None = None,
        report_record_repository: TableRepository | None = None,
        case_repository: TableRepository | None = None,
        dataset_item_repository: TableRepository | None = None,
        run_log_repository: TableRepository | None = None,
        project_repository: ProjectRepository | None = None,
        suite_repository: SuiteRepository | None = None,
        model_gateway_client: ModelGatewayClient | None = None,
    ) -> None:
        self.run_repository = run_repository or RunRepository()
        self.run_item_repository = run_item_repository or TableRepository("run_item")
        self.environment_repository = environment_repository or TableRepository("environment")
        self.judge_record_repository = judge_record_repository or TableRepository("judge_record")
        self.report_record_repository = report_record_repository or TableRepository("report_record")
        self.case_repository = case_repository or TableRepository("case_item")
        self.dataset_item_repository = dataset_item_repository or TableRepository("dataset_item")
        self.run_log_repository = run_log_repository or TableRepository("run_log")
        self.project_repository = project_repository or ProjectRepository()
        self.suite_repository = suite_repository or SuiteRepository()
        self.model_gateway_client = model_gateway_client or ModelGatewayClient()

    def get_run_summary_report(self, run_id: int) -> dict[str, Any]:
        run_record = self._get_run_or_raise(run_id)
        summary = {
            "runId": run_id,
            "runNo": run_record.get("run_no"),
            "runType": run_record.get("run_type"),
            "status": run_record.get("status"),
            "summary": run_record.get("summary") or {"total": 0, "passed": 0, "failed": 0},
            "versionMetadata": self._build_version_metadata(run_record),
        }
        self._persist_report(run_id, "summary", f"Run {run_id} Summary", summary)
        return summary

    def get_run_report(self, run_id: int) -> dict[str, Any]:
        summary = self.get_run_summary_report(run_id)
        detail = self.get_run_detail_report(run_id)
        run_record = self._get_run_or_raise(run_id)
        history = self.run_repository.list(
            project_id=run_record.get("project_id"),
            suite_id=run_record.get("suite_id"),
            run_type=run_record.get("run_type"),
        )
        previous_runs = [item for item in history if item["id"] < run_id]
        previous_runs.sort(key=lambda item: item["id"], reverse=True)
        compare = None
        if previous_runs:
            compare = self.compare_runs(previous_runs[0]["id"], run_id)
        report = {
            **summary,
            "overview": {
                "runId": run_id,
                "runType": run_record.get("run_type"),
                "status": run_record.get("status"),
                "summary": run_record.get("summary") or {"total": 0, "passed": 0, "failed": 0},
            },
            "comparison": compare,
            "detail": detail,
        }
        self._persist_report(run_id, "detailed", f"Run {run_id} Report", report)
        return report

    def get_run_detail_report(self, run_id: int) -> dict[str, Any]:
        run_record = self._get_run_or_raise(run_id)
        items = self.run_item_repository.list({"run_id": run_id})
        logs = self.run_log_repository.list({"run_id": run_id})
        detail = {
            "runId": run_id,
            "runNo": run_record.get("run_no"),
            "runType": run_record.get("run_type"),
            "status": run_record.get("status"),
            "summary": run_record.get("summary") or {"total": 0, "passed": 0, "failed": 0},
            "items": self._enrich_detail_items(items),
            "logs": logs,
        }
        self._persist_report(run_id, "detailed", f"Run {run_id} Detail", detail)
        return detail

    def compare_runs(self, run_id_1: int, run_id_2: int) -> dict[str, Any]:
        run_1 = self._get_run_or_raise(run_id_1)
        run_2 = self._get_run_or_raise(run_id_2)

        summary_1 = run_1.get("summary") or {"total": 0, "passed": 0, "failed": 0}
        summary_2 = run_2.get("summary") or {"total": 0, "passed": 0, "failed": 0}

        comparison = {
            "runId1": run_id_1,
            "runId2": run_id_2,
            "runType": run_2.get("run_type") or run_1.get("run_type"),
            "summary1": summary_1,
            "summary2": summary_2,
            "metrics": self._compare_metrics(run_1, run_2),
            "delta": {
                "passedDelta": int(summary_2.get("passed", 0)) - int(summary_1.get("passed", 0)),
                "failedDelta": int(summary_2.get("failed", 0)) - int(summary_1.get("failed", 0)),
                "totalDelta": int(summary_2.get("total", 0)) - int(summary_1.get("total", 0)),
            },
            "newFailures": self._failed_case_ids(run_id_2) - self._failed_case_ids(run_id_1),
            "fixedCases": self._failed_case_ids(run_id_1) - self._failed_case_ids(run_id_2),
        }
        self._persist_report(run_id_1, "comparison", f"Run {run_id_1} vs {run_id_2}", comparison)
        return comparison

    def get_project_dashboard_report(self, project_id: int) -> dict[str, Any]:
        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")
        runs = self.run_repository.list(project_id=project_id)
        runs.sort(key=lambda item: item["id"])
        suites = {suite["id"]: suite for suite in self.suite_repository.list(project_id=project_id)}
        avg_score_by_run = self._batch_avg_score([run["id"] for run in runs])

        api_runs = [run for run in runs if self._normalize_run_type(run.get("run_type")) == "api_test"]
        benchmark_runs = [run for run in runs if self._normalize_run_type(run.get("run_type")) == "agent_eval"]

        api_pass_rate_trend = [self._build_pass_rate_point(run) for run in api_runs]
        benchmark_avg_score_trend = [self._build_avg_score_point(run, avg_score_by_run) for run in benchmark_runs]

        failure_distribution = self._build_failure_distribution(api_runs)
        dimension_distribution = self._build_dimension_distribution([run["id"] for run in benchmark_runs])

        suite_metrics = []
        for suite_id, suite in suites.items():
            suite_runs = [run for run in runs if run.get("suite_id") == suite_id]
            if not suite_runs:
                continue
            latest_run = max(suite_runs, key=lambda item: item["id"])
            suite_metrics.append(
                {
                    "suiteId": suite_id,
                    "suiteName": suite.get("name"),
                    "passRate": self._run_pass_rate(latest_run),
                    "avgScore": avg_score_by_run.get(latest_run["id"]),
                    "trend": self._suite_trend(suite_runs),
                }
            )

        report = {
            "projectId": project_id,
            "projectName": project.get("name"),
            "generatedAt": datetime.utcnow().isoformat(),
            "api": {
                "passRateTrend": api_pass_rate_trend,
                "failureDistribution": failure_distribution,
            },
            "benchmark": {
                "avgScoreTrend": benchmark_avg_score_trend,
                "dimensionDistribution": dimension_distribution,
            },
            "suites": suite_metrics,
        }
        return report

    def get_dashboard_v1_report(
        self,
        *,
        project_id: int | None = None,
        time_range: str = "7d",
        report_type: str = "all",
        environment: str = "all",
        model: str = "all",
    ) -> dict[str, Any]:
        projects = self.project_repository.list()
        projects_by_id = {
            int(project["id"]): project
            for project in projects
            if isinstance(project, dict) and isinstance(project.get("id"), int)
        }

        selected_project: dict[str, Any] | None = None
        if project_id is not None:
            selected_project = projects_by_id.get(project_id) or self.project_repository.get(project_id)
            if selected_project is None:
                raise NotFoundError(f"project {project_id} not found")
            projects_by_id[project_id] = selected_project
            scoped_project_ids = {project_id}
            project_name = str(selected_project.get("name") or f"project-{project_id}")
            all_runs = self.run_repository.list(project_id=project_id)
        else:
            scoped_project_ids = set(projects_by_id.keys())
            project_name = "全部项目"
            all_runs = self.run_repository.list()
            if scoped_project_ids:
                all_runs = [run for run in all_runs if isinstance(run.get("project_id"), int) and run["project_id"] in scoped_project_ids]
            else:
                all_runs = []
        now = datetime.utcnow()

        def in_range(run: dict[str, Any]) -> bool:
            if time_range == "all":
                return True
            created_at = run.get("created_at")
            if not isinstance(created_at, str) or not created_at:
                return True
            try:
                created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                return True
            delta_days = (now - created_dt.replace(tzinfo=None) if created_dt.tzinfo else now - created_dt).days
            if time_range == "7d":
                return delta_days <= 7
            if time_range == "30d":
                return delta_days <= 30
            return True

        runs = [run for run in all_runs if in_range(run)]

        if report_type == "api":
            runs = [run for run in runs if self._normalize_run_type(run.get("run_type")) == "api_test"]
        elif report_type == "benchmark":
            runs = [run for run in runs if self._normalize_run_type(run.get("run_type")) == "agent_eval"]

        # 当前 run_record 未稳定沉淀 environment/model 字段，先保持 all 过滤语义（向前兼容）
        if environment != "all":
            runs = [run for run in runs if str(run.get("environment_id") or "") == environment or environment == "all"]

        if model != "all":
            matched_run_ids: set[int] = set()
            for run in runs:
                run_items = self.run_item_repository.list({"run_id": run["id"]})
                for item in run_items:
                    response_data = item.get("response_data")
                    if isinstance(response_data, dict) and str(response_data.get("model") or "") == model:
                        matched_run_ids.add(run["id"])
                        break
            runs = [run for run in runs if run["id"] in matched_run_ids]

        runs.sort(key=lambda item: item["id"])
        avg_score_by_run = self._batch_avg_score([run["id"] for run in runs])

        api_runs = [run for run in runs if self._normalize_run_type(run.get("run_type")) == "api_test"]
        benchmark_runs = [run for run in runs if self._normalize_run_type(run.get("run_type")) == "agent_eval"]

        run_count = len(runs)
        avg_pass_rate = round(sum(self._run_pass_rate(run) for run in runs) / run_count, 2) if run_count else 0.0
        avg_score = round(sum(avg_score_by_run.get(run["id"], 0.0) for run in benchmark_runs) / len(benchmark_runs), 4) if benchmark_runs else 0.0
        api_success_rate = round(sum(self._run_pass_rate(run) for run in api_runs) / len(api_runs), 2) if api_runs else 0.0
        fail_rate = round(100.0 - avg_pass_rate, 2) if run_count else 0.0

        dimension_distribution = self._build_dimension_distribution([run["id"] for run in benchmark_runs])
        failure_distribution = self._build_failure_distribution(api_runs)

        suite_map = {
            suite["id"]: suite
            for suite in (self.suite_repository.list(project_id=project_id) if project_id is not None else self.suite_repository.list())
            if isinstance(suite.get("id"), int)
        }
        suites_payload: list[dict[str, Any]] = []
        for suite_id, suite in suite_map.items():
            suite_runs = [run for run in runs if run.get("suite_id") == suite_id]
            if not suite_runs:
                continue
            latest = max(suite_runs, key=lambda item: item["id"])
            suites_payload.append(
                {
                    "suiteId": suite_id,
                    "suiteName": suite.get("name"),
                    "projectId": suite.get("project_id"),
                    "passRate": self._run_pass_rate(latest),
                    "avgScore": avg_score_by_run.get(latest["id"]),
                    "trend": self._suite_trend(suite_runs),
                }
            )

        projects_payload: list[dict[str, Any]] = []
        for scoped_project_id in sorted(scoped_project_ids):
            scoped_runs = [run for run in runs if run.get("project_id") == scoped_project_id]
            scoped_api_runs = [run for run in scoped_runs if self._normalize_run_type(run.get("run_type")) == "api_test"]
            scoped_benchmark_runs = [run for run in scoped_runs if self._normalize_run_type(run.get("run_type")) == "agent_eval"]
            scoped_run_count = len(scoped_runs)
            scoped_avg_pass_rate = (
                round(sum(self._run_pass_rate(run) for run in scoped_runs) / scoped_run_count, 2) if scoped_run_count else 0.0
            )
            scoped_api_success_rate = (
                round(sum(self._run_pass_rate(run) for run in scoped_api_runs) / len(scoped_api_runs), 2)
                if scoped_api_runs
                else 0.0
            )
            scoped_avg_score = (
                round(sum(avg_score_by_run.get(run["id"], 0.0) for run in scoped_benchmark_runs) / len(scoped_benchmark_runs), 4)
                if scoped_benchmark_runs
                else 0.0
            )
            project_record = projects_by_id.get(scoped_project_id, {})
            projects_payload.append(
                {
                    "projectId": scoped_project_id,
                    "projectName": project_record.get("name") or f"project-{scoped_project_id}",
                    "runCount": scoped_run_count,
                    "avgPassRate": scoped_avg_pass_rate,
                    "apiSuccessRate": scoped_api_success_rate,
                    "avgScore": scoped_avg_score,
                    "failRate": round(100.0 - scoped_avg_pass_rate, 2) if scoped_run_count else 0.0,
                }
            )
        projects_payload.sort(key=lambda item: (item["apiSuccessRate"], item["runCount"]), reverse=True)

        return {
            "projectId": project_id,
            "projectName": project_name,
            "generatedAt": datetime.utcnow().isoformat(),
            "filters": {
                "timeRange": time_range if time_range in {"7d", "30d", "all"} else "7d",
                "type": report_type if report_type in {"all", "api", "benchmark"} else "all",
                "environment": environment,
                "model": model,
            },
            "kpis": {
                "projectCount": 1 if project_id is not None else len(scoped_project_ids),
                "runCount": run_count,
                "avgPassRate": avg_pass_rate,
                "avgScore": avg_score,
                "apiSuccessRate": api_success_rate,
                "failRate": fail_rate,
                "p95LatencyMs": 0,
                "totalCost": 0,
            },
            "trends": {
                "apiPassRate": [
                    {"runId": run["id"], "createdAt": run.get("created_at"), "value": self._run_pass_rate(run)}
                    for run in api_runs
                ],
                "benchmarkScore": [
                    {"runId": run["id"], "createdAt": run.get("created_at"), "value": avg_score_by_run.get(run["id"], 0.0)}
                    for run in benchmark_runs
                ],
            },
            "distributions": {
                "failure": failure_distribution,
                "benchmarkDimensions": [
                    {"name": item.get("dimension", "-"), "value": float(item.get("avgScore", 0.0))}
                    for item in dimension_distribution
                ],
            },
            "suites": suites_payload,
            "projects": projects_payload,
        }

    def get_suite_analytics_report(self, suite_id: int, recent_limit: int | None = 10) -> dict[str, Any]:
        suite = self.suite_repository.get(suite_id)
        if suite is None:
            raise NotFoundError(f"suite {suite_id} not found")
        runs = self.run_repository.list(project_id=suite["project_id"], suite_id=suite_id)
        runs.sort(key=lambda item: item["id"], reverse=True)
        if isinstance(recent_limit, int) and recent_limit > 0:
            recent_runs = runs[:recent_limit]
        else:
            recent_runs = runs
        avg_score_by_run = self._batch_avg_score([run["id"] for run in recent_runs])

        api_runs = [run for run in recent_runs if self._normalize_run_type(run.get("run_type")) == "api_test"]
        benchmark_runs = [run for run in recent_runs if self._normalize_run_type(run.get("run_type")) == "agent_eval"]
        api_run_ids = [run["id"] for run in api_runs]
        api_quality_profile = self._build_api_quality_profile(api_runs)

        report = {
            "suiteId": suite_id,
            "suiteName": suite.get("name"),
            "projectId": suite.get("project_id"),
            "generatedAt": datetime.utcnow().isoformat(),
            "runHistory": [
                {
                    "runId": run["id"],
                    "runType": run.get("run_type"),
                    "status": run.get("status"),
                    "createdAt": run.get("created_at"),
                    "passRate": self._run_pass_rate(run),
                    "avgScore": avg_score_by_run.get(run["id"]),
                }
                for run in recent_runs
            ],
            "api": {
                "topFailedCases": self._top_failed_cases(api_run_ids),
                "errorTypeDistribution": self._error_type_distribution(api_run_ids),
                "qualitySummary": api_quality_profile.get("qualitySummary"),
                "latestRunInsight": api_quality_profile.get("latestRunInsight"),
                "statusCodeDistribution": api_quality_profile.get("statusCodeDistribution"),
                "topSlowCases": api_quality_profile.get("topSlowCases"),
                "flakyCases": api_quality_profile.get("flakyCases"),
            },
            "benchmark": {
                "dimensionTrend": self._dimension_trend([run["id"] for run in benchmark_runs]),
                "lowScoreCases": self._low_score_cases([run["id"] for run in benchmark_runs]),
            },
        }
        return report

    def export_run_report(self, run_id: int) -> dict[str, Any]:
        summary = self.get_run_summary_report(run_id)
        file_url = f"/exports/reports/run-{run_id}-summary.json"
        report_record = self.report_record_repository.create(
            {
                "run_id": run_id,
                "report_type": "summary",
                "title": f"Run {run_id} Export",
                "content_json": self._to_jsonable(summary),
                "file_url": file_url,
            }
        )
        return {
            "runId": run_id,
            "reportId": report_record["id"],
            "fileUrl": file_url,
        }

    def export_run_report_html(self, run_id: int) -> dict[str, Any]:
        report = self.get_run_report(run_id)
        html_content = self._build_run_report_html(report)
        file_url = f"/exports/reports/run-{run_id}-report.html"
        report_record = self.report_record_repository.create(
            {
                "run_id": run_id,
                "report_type": "detailed",
                "title": f"Run {run_id} HTML Report",
                "content_json": {"html": html_content[:2000]},
                "file_url": file_url,
            }
        )
        return {
            "runId": run_id,
            "reportId": report_record["id"],
            "fileUrl": file_url,
            "contentPreview": html_content[:600],
        }

    def export_dashboard_v1_markdown_report(
        self,
        *,
        project_id: int | None = None,
        time_range: str = "7d",
        report_type: str = "all",
        environment: str = "all",
        model: str = "all",
    ) -> dict[str, Any]:
        report = self.get_dashboard_v1_report(
            project_id=project_id,
            time_range=time_range,
            report_type=report_type,
            environment=environment,
            model=model,
        )
        generated_at = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        file_name = f"dashboard-{project_id if isinstance(project_id, int) else 'all'}-{generated_at}-detailed-report.md"

        summary_mode = "llm"
        model_name: str | None = None
        llm_error: str | None = None

        resolved_project_id = project_id
        if resolved_project_id is None:
            projects = report.get("projects") if isinstance(report.get("projects"), list) else []
            if projects:
                first_project = projects[0]
                if isinstance(first_project, dict) and isinstance(first_project.get("projectId"), int):
                    resolved_project_id = int(first_project["projectId"])

        filters = {
            "projectId": project_id,
            "timeRange": time_range,
            "type": report_type,
            "environment": environment,
            "model": model,
        }

        try:
            llm_result = self.model_gateway_client.complete(
                project_id=resolved_project_id,
                prompt=self._dashboard_markdown_prompt(),
                user_input=self._dashboard_markdown_user_input(report=report, filters=filters),
                context=self._dashboard_markdown_context(report=report, filters=filters),
                config={"temperature": 0.2},
            )
            model_name = str(llm_result.get("model_name") or "").strip() or None
            markdown_content = self._extract_markdown_text(llm_result)
        except Exception as exc:
            summary_mode = "fallback"
            llm_error = str(exc)
            markdown_content = self._build_dashboard_markdown_fallback(report=report, filters=filters, llm_error=llm_error)

        if not markdown_content.strip():
            summary_mode = "fallback"
            markdown_content = self._build_dashboard_markdown_fallback(report=report, filters=filters, llm_error=llm_error)

        return {
            "projectId": report.get("projectId"),
            "projectName": report.get("projectName"),
            "generatedAt": datetime.utcnow().isoformat(),
            "filters": filters,
            "fileName": file_name,
            "markdownContent": markdown_content,
            "summaryMode": summary_mode,
            "model": model_name,
            "llmError": llm_error,
        }

    def export_dashboard_v1_image(
        self,
        *,
        project_id: int | None = None,
        time_range: str = "7d",
        report_type: str = "all",
        environment: str = "all",
        model: str = "all",
    ) -> dict[str, Any]:
        normalized_project_id = project_id if isinstance(project_id, int) and project_id > 0 else None
        if normalized_project_id is not None and self.project_repository.get(normalized_project_id) is None:
            raise NotFoundError(f"project {normalized_project_id} not found")

        filters = {
            "projectId": normalized_project_id,
            "timeRange": time_range,
            "type": report_type,
            "environment": environment,
            "model": model,
        }
        report_page_url = self._build_dashboard_v1_page_url(
            project_id=normalized_project_id,
            time_range=time_range,
            report_type=report_type,
            environment=environment,
            model=model,
        )
        screenshot_url = self._build_dashboard_v1_screenshot_url(
            project_id=normalized_project_id,
            time_range=time_range,
            report_type=report_type,
            environment=environment,
            model=model,
            report_page_url=report_page_url,
        )
        return {
            "projectId": normalized_project_id,
            "generatedAt": datetime.utcnow().isoformat(),
            "filters": filters,
            "reportPageUrl": report_page_url,
            "screenshotUrl": screenshot_url,
        }

    def export_suite_markdown_report(self, suite_id: int, *, recent_limit: int | None = 10) -> dict[str, Any]:
        report = self.get_suite_analytics_report(suite_id, recent_limit=recent_limit)
        suite_name = str(report.get("suiteName") or f"suite-{suite_id}")
        generated_at = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        file_name = f"suite-{suite_id}-{generated_at}-detailed-report.md"

        summary_mode = "llm"
        model_name: str | None = None
        llm_error: str | None = None

        try:
            llm_result = self.model_gateway_client.complete(
                project_id=report.get("projectId") if isinstance(report.get("projectId"), int) else None,
                prompt=self._suite_markdown_prompt(),
                user_input=self._suite_markdown_user_input(report),
                context=self._suite_markdown_context(report),
                config={"temperature": 0.2},
            )
            model_name = str(llm_result.get("model_name") or "").strip() or None
            markdown_content = self._extract_markdown_text(llm_result)
        except Exception as exc:
            summary_mode = "fallback"
            llm_error = str(exc)
            markdown_content = self._build_suite_markdown_fallback(report, llm_error=llm_error)

        if not markdown_content.strip():
            summary_mode = "fallback"
            markdown_content = self._build_suite_markdown_fallback(report, llm_error=llm_error)

        return {
            "suiteId": suite_id,
            "suiteName": suite_name,
            "generatedAt": datetime.utcnow().isoformat(),
            "fileName": file_name,
            "markdownContent": markdown_content,
            "summaryMode": summary_mode,
            "model": model_name,
            "llmError": llm_error,
        }

    def _get_run_or_raise(self, run_id: int) -> dict[str, Any]:
        run_record = self.run_repository.get(run_id)
        if run_record is None:
            raise NotFoundError(f"run {run_id} not found")
        return run_record

    @staticmethod
    def _dashboard_markdown_prompt() -> str:
        return (
            "你是一名资深测试与质量分析顾问。"
            "请基于提供的项目看板筛选报告数据，输出一份中文 Markdown《详细测试报告》。"
            "要求：\n"
            "1) 仅输出 Markdown 正文，不要 JSON，不要代码块包裹。\n"
            "2) 必须覆盖：筛选范围说明、执行摘要、总体质量概览、趋势分析(API/Benchmark)、风险清单、治理建议、下轮验证计划。\n"
            "3) 结论必须来源于输入数据，不要编造不存在的指标。\n"
            "4) 尽量使用表格和分点，结论要可执行且详细。\n"
            "5) 若某部分数据为空，明确写出“当前无数据”并给替代建议。"
        )

    @staticmethod
    def _dashboard_markdown_user_input(report: dict[str, Any], filters: dict[str, Any]) -> dict[str, Any]:
        return {
            "task": "基于项目看板筛选结果生成详细测试报告（markdown）",
            "project_id": report.get("projectId"),
            "project_name": report.get("projectName"),
            "generated_at": report.get("generatedAt"),
            "filters": filters,
            "output_language": "zh-CN",
            "detail_level": "detailed",
        }

    def _dashboard_markdown_context(self, report: dict[str, Any], filters: dict[str, Any]) -> dict[str, Any]:
        kpis = report.get("kpis") if isinstance(report.get("kpis"), dict) else {}
        trends = report.get("trends") if isinstance(report.get("trends"), dict) else {}
        distributions = report.get("distributions") if isinstance(report.get("distributions"), dict) else {}
        suites = report.get("suites") if isinstance(report.get("suites"), list) else []
        projects = report.get("projects") if isinstance(report.get("projects"), list) else []
        api_trend = trends.get("apiPassRate") if isinstance(trends.get("apiPassRate"), list) else []
        benchmark_trend = trends.get("benchmarkScore") if isinstance(trends.get("benchmarkScore"), list) else []
        failure_distribution = distributions.get("failure") if isinstance(distributions.get("failure"), list) else []
        benchmark_dimensions = distributions.get("benchmarkDimensions") if isinstance(distributions.get("benchmarkDimensions"), list) else []
        top_failure = failure_distribution[0] if failure_distribution else None

        return {
            "scope": {
                "projectId": report.get("projectId"),
                "projectName": report.get("projectName"),
                "filters": filters,
                "generatedAt": report.get("generatedAt"),
            },
            "summary": {
                "runCount": kpis.get("runCount", 0),
                "avgPassRate": kpis.get("avgPassRate", 0),
                "avgScore": kpis.get("avgScore", 0),
                "apiSuccessRate": kpis.get("apiSuccessRate", 0),
                "failRate": kpis.get("failRate", 0),
                "projectCount": kpis.get("projectCount", 0),
                "suiteCount": len(suites),
                "apiTrendPoints": len(api_trend),
                "benchmarkTrendPoints": len(benchmark_trend),
                "topFailure": top_failure,
                "benchmarkDimensionCount": len(benchmark_dimensions),
            },
            "kpis": kpis,
            "trends": trends,
            "distributions": distributions,
            "suites": suites,
            "projects": projects,
        }

    def _build_dashboard_markdown_fallback(self, report: dict[str, Any], filters: dict[str, Any], llm_error: str | None = None) -> str:
        generated_at = str(report.get("generatedAt") or datetime.utcnow().isoformat())
        kpis = report.get("kpis") if isinstance(report.get("kpis"), dict) else {}
        trends = report.get("trends") if isinstance(report.get("trends"), dict) else {}
        distributions = report.get("distributions") if isinstance(report.get("distributions"), dict) else {}
        suites = report.get("suites") if isinstance(report.get("suites"), list) else []
        projects = report.get("projects") if isinstance(report.get("projects"), list) else []

        api_trend = trends.get("apiPassRate") if isinstance(trends.get("apiPassRate"), list) else []
        benchmark_trend = trends.get("benchmarkScore") if isinstance(trends.get("benchmarkScore"), list) else []
        failure_distribution = distributions.get("failure") if isinstance(distributions.get("failure"), list) else []
        benchmark_dimensions = distributions.get("benchmarkDimensions") if isinstance(distributions.get("benchmarkDimensions"), list) else []

        lines: list[str] = []
        lines.append("# 项目看板测试报告（详细版）")
        lines.append("")
        lines.append(f"- 项目: `{report.get('projectName', '全部项目')}`")
        lines.append(f"- 生成时间: `{generated_at}`")
        lines.append(f"- 筛选: `projectId={filters.get('projectId')}` `timeRange={filters.get('timeRange')}` `type={filters.get('type')}` `environment={filters.get('environment')}` `model={filters.get('model')}`")
        if llm_error:
            lines.append(f"- 说明: 模型总结不可用，已回退模板生成（原因: `{llm_error}`）")
        lines.append("")
        lines.append("## 执行摘要")
        lines.append("")
        lines.append(f"1. 当前筛选范围运行总数 `{kpis.get('runCount', 0)}`，总通过率 `{kpis.get('avgPassRate', 0)}%`。")
        lines.append(f"2. API 成功率 `{kpis.get('apiSuccessRate', 0)}%`，错误率 `{kpis.get('failRate', 0)}%`。")
        lines.append(f"3. Benchmark 平均分 `{kpis.get('avgScore', 0)}`，建议结合维度分布持续优化。")
        lines.append("")
        lines.append("## 趋势分析")
        lines.append("")
        lines.append(f"- API 趋势点数: `{len(api_trend)}`")
        lines.append(f"- Benchmark 趋势点数: `{len(benchmark_trend)}`")
        lines.append("")
        lines.append("## 失败分布")
        lines.append("")
        if failure_distribution:
            lines.append("| 类型 | 数量 |")
            lines.append("| --- | --- |")
            for item in failure_distribution[:10]:
                lines.append(f"| {item.get('name', '-')} | {item.get('value', 0)} |")
        else:
            lines.append("- 当前无失败分布数据。")
        lines.append("")
        lines.append("## Benchmark 维度分布")
        lines.append("")
        if benchmark_dimensions:
            lines.append("| 维度 | 分数 |")
            lines.append("| --- | --- |")
            for item in benchmark_dimensions[:10]:
                lines.append(f"| {item.get('name', '-')} | {item.get('value', 0)} |")
        else:
            lines.append("- 当前无 Benchmark 维度数据。")
        lines.append("")
        lines.append("## Suite / 项目表现")
        lines.append("")
        if suites:
            lines.append("| Suite | passRate | avgScore | trend |")
            lines.append("| --- | --- | --- | --- |")
            for item in suites[:20]:
                lines.append(
                    f"| {item.get('suiteName', '-')} | {item.get('passRate', 0)} | {item.get('avgScore', '-')} | {item.get('trend', '-')} |"
                )
        elif projects:
            lines.append("| 项目 | runCount | apiSuccessRate | avgScore | failRate |")
            lines.append("| --- | --- | --- | --- | --- |")
            for item in projects[:20]:
                lines.append(
                    f"| {item.get('projectName', '-')} | {item.get('runCount', 0)} | {item.get('apiSuccessRate', 0)} | {item.get('avgScore', 0)} | {item.get('failRate', 0)} |"
                )
        else:
            lines.append("- 当前无 Suite 或项目表现数据。")
        lines.append("")
        lines.append("## 风险与治理建议")
        lines.append("")
        lines.append("1. 优先处理失败分布中占比最高的问题类型。")
        lines.append("2. 对低分维度建立专项优化清单并跟踪趋势变化。")
        lines.append("3. 下一轮以相同筛选条件回归，确认核心指标改善。")
        lines.append("")
        return "\n".join(lines).strip()

    @staticmethod
    def _suite_markdown_prompt() -> str:
        return (
            "你是一名资深测试与质量分析顾问。"
            "请基于提供的 suite 报告数据，输出一份中文 Markdown《详细测试报告》。"
            "要求：\n"
            "1) 仅输出 Markdown 正文，不要 JSON，不要代码块包裹。\n"
            "2) 报告必须覆盖：执行摘要、运行概况、API 质量分析、Benchmark 质量分析、风险清单、改进建议、后续验证计划。\n"
            "3) 结论必须来源于输入数据，不要编造不存在的指标或 run。\n"
            "4) 尽量使用表格和分点，结论要可执行，内容详细。\n"
            "5) 如果某类数据缺失，明确写出“当前无数据”并给出替代建议。"
        )

    @staticmethod
    def _suite_markdown_user_input(report: dict[str, Any]) -> dict[str, Any]:
        return {
            "task": "生成详细版 suite 测试报告（markdown）",
            "suite_id": report.get("suiteId"),
            "suite_name": report.get("suiteName"),
            "project_id": report.get("projectId"),
            "generated_at": report.get("generatedAt"),
            "output_language": "zh-CN",
            "detail_level": "detailed",
        }

    @staticmethod
    def _build_dashboard_v1_page_url(
        *,
        project_id: int | None,
        time_range: str,
        report_type: str,
        environment: str,
        model: str,
    ) -> str | None:
        web_base_url = (
            os.getenv("NEPTUNE_WEB_BASE_URL", "").strip()
            or os.getenv("NEPTUNE_BASE_URL", "").strip()
            or os.getenv("WEB_BASE_URL", "").strip()
            or os.getenv("FRONTEND_BASE_URL", "").strip()
            or os.getenv("DASHBOARD_WEB_BASE_URL", "").strip()
            or os.getenv("REPORT_WEB_BASE_URL", "").strip()
        )
        if not web_base_url and ReportService._is_report_link_fallback_enabled():
            web_base_url = DEFAULT_DASHBOARD_WEB_BASE_URL
        if not web_base_url:
            return None
        query: dict[str, str | int] = {
            "timeRange": time_range,
            "type": report_type,
            "environment": environment,
            "model": model,
        }
        if isinstance(project_id, int) and project_id > 0:
            query["projectId"] = project_id
        base = web_base_url.rstrip("/")
        return f"{base}/reports/project?{urlencode(query)}"

    @staticmethod
    def _build_dashboard_v1_screenshot_url(
        *,
        project_id: int | None,
        time_range: str,
        report_type: str,
        environment: str,
        model: str,
        report_page_url: str | None,
    ) -> str | None:
        template = (
            os.getenv("DASHBOARD_EXPORT_IMAGE_URL_TEMPLATE", "").strip()
            or os.getenv("REPORT_PAGE_SCREENSHOT_URL_TEMPLATE", "").strip()
        )
        if not template and ReportService._is_report_link_fallback_enabled():
            template = DEFAULT_DASHBOARD_SCREENSHOT_URL_TEMPLATE
        if not template:
            return None

        project_value = str(project_id) if isinstance(project_id, int) and project_id > 0 else ""
        page_url_value = (report_page_url or "").strip()
        try:
            rendered = template.format(
                project_id=project_value,
                time_range=time_range,
                report_type=report_type,
                environment=environment,
                model=model,
                project_report_url=page_url_value,
                project_report_url_encoded=quote(page_url_value, safe=""),
                report_page_url=page_url_value,
                report_page_url_encoded=quote(page_url_value, safe=""),
                time_range_encoded=quote(time_range, safe=""),
                report_type_encoded=quote(report_type, safe=""),
                environment_encoded=quote(environment, safe=""),
                model_encoded=quote(model, safe=""),
            ).strip()
        except Exception:  # noqa: BLE001
            return None
        return rendered or None

    @staticmethod
    def _is_report_link_fallback_enabled() -> bool:
        raw = os.getenv(REPORT_LINK_FALLBACK_ENABLED_ENV, "").strip().lower()
        return raw in {"1", "true", "yes", "on"}

    def _suite_markdown_context(self, report: dict[str, Any]) -> dict[str, Any]:
        run_history = report.get("runHistory") if isinstance(report.get("runHistory"), list) else []
        api_history = [item for item in run_history if self._normalize_run_type(item.get("runType")) == "api_test"]
        benchmark_history = [item for item in run_history if self._normalize_run_type(item.get("runType")) == "agent_eval"]

        api_top_failed = (
            report.get("api", {}).get("topFailedCases")
            if isinstance(report.get("api"), dict) and isinstance(report.get("api", {}).get("topFailedCases"), list)
            else []
        )
        error_distribution = (
            report.get("api", {}).get("errorTypeDistribution")
            if isinstance(report.get("api"), dict) and isinstance(report.get("api", {}).get("errorTypeDistribution"), list)
            else []
        )
        low_score_cases = (
            report.get("benchmark", {}).get("lowScoreCases")
            if isinstance(report.get("benchmark"), dict) and isinstance(report.get("benchmark", {}).get("lowScoreCases"), list)
            else []
        )
        dimension_trend = (
            report.get("benchmark", {}).get("dimensionTrend")
            if isinstance(report.get("benchmark"), dict) and isinstance(report.get("benchmark", {}).get("dimensionTrend"), list)
            else []
        )

        avg_pass_rate = (
            round(
                sum(float(item.get("passRate") or 0.0) for item in api_history if isinstance(item, dict)) / len(api_history),
                2,
            )
            if api_history
            else 0.0
        )
        avg_benchmark_score = (
            round(
                sum(float(item.get("avgScore") or 0.0) for item in benchmark_history if isinstance(item, dict)) / len(benchmark_history),
                4,
            )
            if benchmark_history
            else 0.0
        )

        return {
            "suite": {
                "suiteId": report.get("suiteId"),
                "suiteName": report.get("suiteName"),
                "projectId": report.get("projectId"),
                "generatedAt": report.get("generatedAt"),
            },
            "summary": {
                "totalRuns": len(run_history),
                "apiRunCount": len(api_history),
                "benchmarkRunCount": len(benchmark_history),
                "avgApiPassRate": avg_pass_rate,
                "avgBenchmarkScore": avg_benchmark_score,
                "errorTypeCount": len(error_distribution),
                "topFailedCaseCount": len(api_top_failed),
                "lowScoreCaseCount": len(low_score_cases),
            },
            "runHistory": run_history,
            "api": {
                "topFailedCases": api_top_failed,
                "errorTypeDistribution": error_distribution,
            },
            "benchmark": {
                "dimensionTrend": dimension_trend,
                "lowScoreCases": low_score_cases,
            },
        }

    def _extract_markdown_text(self, llm_result: dict[str, Any]) -> str:
        raw_output = llm_result.get("raw_output")
        parsed_output = llm_result.get("parsed_output")
        text = raw_output if isinstance(raw_output, str) else parsed_output if isinstance(parsed_output, str) else ""
        markdown = text.strip()
        if markdown.startswith("```"):
            lines = markdown.splitlines()
            if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].startswith("```"):
                markdown = "\n".join(lines[1:-1]).strip()
        return markdown

    def _build_suite_markdown_fallback(self, report: dict[str, Any], llm_error: str | None = None) -> str:
        suite_id = report.get("suiteId")
        suite_name = str(report.get("suiteName") or f"suite-{suite_id}")
        generated_at = str(report.get("generatedAt") or datetime.utcnow().isoformat())
        run_history = report.get("runHistory") if isinstance(report.get("runHistory"), list) else []
        api_runs = [item for item in run_history if self._normalize_run_type(item.get("runType")) == "api_test"]
        benchmark_runs = [item for item in run_history if self._normalize_run_type(item.get("runType")) == "agent_eval"]

        avg_api_pass = (
            round(sum(float(item.get("passRate") or 0.0) for item in api_runs if isinstance(item, dict)) / len(api_runs), 2)
            if api_runs
            else 0.0
        )
        avg_benchmark_score = (
            round(sum(float(item.get("avgScore") or 0.0) for item in benchmark_runs if isinstance(item, dict)) / len(benchmark_runs), 4)
            if benchmark_runs
            else 0.0
        )

        api_top_failed = (
            report.get("api", {}).get("topFailedCases")
            if isinstance(report.get("api"), dict) and isinstance(report.get("api", {}).get("topFailedCases"), list)
            else []
        )
        error_distribution = (
            report.get("api", {}).get("errorTypeDistribution")
            if isinstance(report.get("api"), dict) and isinstance(report.get("api", {}).get("errorTypeDistribution"), list)
            else []
        )
        dimension_trend = (
            report.get("benchmark", {}).get("dimensionTrend")
            if isinstance(report.get("benchmark"), dict) and isinstance(report.get("benchmark", {}).get("dimensionTrend"), list)
            else []
        )
        low_score_cases = (
            report.get("benchmark", {}).get("lowScoreCases")
            if isinstance(report.get("benchmark"), dict) and isinstance(report.get("benchmark", {}).get("lowScoreCases"), list)
            else []
        )

        lines: list[str] = []
        lines.append("# Suite 测试报告（详细版）")
        lines.append("")
        lines.append(f"- Suite: `{suite_name}` (ID: {suite_id})")
        lines.append(f"- 生成时间: `{generated_at}`")
        lines.append(f"- 总运行次数: `{len(run_history)}`")
        lines.append(f"- API 运行次数: `{len(api_runs)}`，平均通过率: `{avg_api_pass:.2f}%`")
        lines.append(f"- Benchmark 运行次数: `{len(benchmark_runs)}`，平均分: `{avg_benchmark_score:.4f}`")
        if llm_error:
            lines.append(f"- 说明: 模型总结不可用，已回退模板生成（原因: `{llm_error}`）")
        lines.append("")
        lines.append("## 执行摘要")
        lines.append("")
        lines.append("1. 当前报告基于最近运行历史生成，重点覆盖 API 稳定性与 Benchmark 质量。")
        lines.append("2. 建议先处理高频失败样本，再处理低分样本，以提升整体质量指标。")
        lines.append("3. 若短期要提升质量，应优先控制错误类型 Top 项并复盘关键低分维度。")
        lines.append("")
        lines.append("## 运行概况")
        lines.append("")
        if run_history:
            lines.append("| run_id | 类型 | 状态 | pass_rate | avg_score | created_at |")
            lines.append("| --- | --- | --- | --- | --- | --- |")
            for run in run_history[:10]:
                run_type = "benchmark" if self._normalize_run_type(run.get("runType")) == "agent_eval" else "api_test"
                pass_rate = run.get("passRate")
                avg_score = run.get("avgScore")
                pass_rate_text = f"{float(pass_rate):.2f}%" if isinstance(pass_rate, (int, float)) else "-"
                score_text = f"{float(avg_score):.4f}" if isinstance(avg_score, (int, float)) else "-"
                lines.append(
                    f"| {run.get('runId', '-')} | {run_type} | {run.get('status', '-')} | {pass_rate_text} | {score_text} | {run.get('createdAt', '-')} |"
                )
        else:
            lines.append("当前无运行历史数据。")
        lines.append("")
        lines.append("## API 质量分析")
        lines.append("")
        if api_top_failed:
            lines.append("### Top 失败样本")
            lines.append("")
            lines.append("| case | failed_count |")
            lines.append("| --- | --- |")
            for item in api_top_failed[:10]:
                lines.append(f"| {item.get('caseName', '-')} | {item.get('failedCount', 0)} |")
            lines.append("")
        else:
            lines.append("- 当前无失败样本数据。")
            lines.append("")

        if error_distribution:
            lines.append("### 错误类型分布")
            lines.append("")
            lines.append("| error_type | count |")
            lines.append("| --- | --- |")
            for item in error_distribution[:10]:
                lines.append(f"| {item.get('name', '-')} | {item.get('value', 0)} |")
            lines.append("")
        else:
            lines.append("- 当前无错误类型分布数据。")
            lines.append("")

        lines.append("## Benchmark 质量分析")
        lines.append("")
        if low_score_cases:
            lines.append("### 低分样本")
            lines.append("")
            lines.append("| run_id | case_name | score |")
            lines.append("| --- | --- | --- |")
            for item in low_score_cases[:10]:
                score_value = item.get("score")
                score_text = f"{float(score_value):.4f}" if isinstance(score_value, (int, float)) else "-"
                lines.append(f"| {item.get('runId', '-')} | {item.get('caseName', '-')} | {score_text} |")
            lines.append("")
        else:
            lines.append("- 当前无低分样本。")
            lines.append("")

        if dimension_trend:
            lines.append("### 维度趋势")
            lines.append("")
            for point in dimension_trend[:5]:
                run_id = point.get("runId", "-")
                dimensions = point.get("dimensions") if isinstance(point.get("dimensions"), list) else []
                if not dimensions:
                    continue
                lines.append(f"- Run `{run_id}`:")
                for dimension in dimensions[:8]:
                    dimension_name = dimension.get("dimension", "-")
                    avg_score = dimension.get("avgScore")
                    score_text = f"{float(avg_score):.4f}" if isinstance(avg_score, (int, float)) else "-"
                    lines.append(f"  - {dimension_name}: {score_text}")
            lines.append("")
        else:
            lines.append("- 当前无维度趋势数据。")
            lines.append("")

        lines.append("## 风险清单")
        lines.append("")
        lines.append("1. 高频失败样本可能导致核心链路稳定性下降。")
        lines.append("2. 低分样本集中在少数维度时，存在评测能力短板。")
        lines.append("3. 若错误类型集中且持续出现，说明缺陷未闭环。")
        lines.append("")
        lines.append("## 改进建议")
        lines.append("")
        lines.append("1. 先处理 Top 失败样本，降低失败基数，再回归验证。")
        lines.append("2. 对低分样本按维度拆解规则与提示词，逐项优化。")
        lines.append("3. 建立错误类型责任归口，每日跟踪下降趋势。")
        lines.append("")
        lines.append("## 后续验证计划")
        lines.append("")
        lines.append("1. 连续 3 个 run 对比通过率/均分变化，确认改进有效。")
        lines.append("2. 对已修复样本做回归集监控，防止回退。")
        lines.append("3. 固化周报模板，持续输出 suite 级质量结论。")
        lines.append("")
        return "\n".join(lines).strip()

    def _build_version_metadata(self, run_record: dict[str, Any]) -> dict[str, Any]:
        environment = None
        if run_record.get("environment_id"):
            environment = self.environment_repository.get(run_record["environment_id"])

        run_items = self.run_item_repository.list({"run_id": run_record["id"]})
        model_versions = set()
        model_names = set()
        for run_item in run_items:
            for judge_record in self.judge_record_repository.list({"run_item_id": run_item["id"]}):
                if judge_record.get("model_version"):
                    model_versions.add(judge_record["model_version"])
                if judge_record.get("model_name"):
                    model_names.add(judge_record["model_name"])

        return {
            "modelVersions": sorted(model_versions),
            "modelNames": sorted(model_names),
            "environmentVersion": None
            if environment is None
            else {
                "environmentId": environment.get("id"),
                "envType": environment.get("env_type"),
                "updatedAt": environment.get("updated_at"),
            },
            "ruleVersions": [],
        }

    def _enrich_detail_items(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        case_map: dict[int, dict[str, Any]] = {}
        dataset_item_map: dict[int, dict[str, Any]] = {}
        suite_case_map: dict[int, list[dict[str, Any]]] = {}
        for item in items:
            case_id = item.get("case_id")
            if isinstance(case_id, int) and case_id not in case_map:
                case_record = self.case_repository.get(case_id)
                if case_record is not None:
                    case_map[case_id] = case_record
                    suite_id = case_record.get("suite_id")
                    if isinstance(suite_id, int) and suite_id not in suite_case_map:
                        suite_case_map[suite_id] = self.case_repository.list({"suite_id": suite_id})
            dataset_item_id = item.get("dataset_item_id")
            if isinstance(dataset_item_id, int) and dataset_item_id not in dataset_item_map:
                dataset_item_record = self.dataset_item_repository.get(dataset_item_id)
                if dataset_item_record is not None:
                    dataset_item_map[dataset_item_id] = dataset_item_record

        enriched_items: list[dict[str, Any]] = []
        for item in items:
            enriched = dict(item)
            case_id = enriched.get("case_id")
            dataset_item_id = enriched.get("dataset_item_id")
            case_record = case_map.get(case_id) if isinstance(case_id, int) else None
            dataset_item_record = dataset_item_map.get(dataset_item_id) if isinstance(dataset_item_id, int) else None

            case_name = case_record.get("name") if case_record else None
            method = None
            path = None
            if case_record and isinstance(case_record.get("input_payload"), dict):
                method = case_record["input_payload"].get("method")
                path = case_record["input_payload"].get("path")

            input_summary = None
            if dataset_item_record and isinstance(dataset_item_record.get("input_data"), dict):
                raw_input = dataset_item_record["input_data"].get("user_input")
                if isinstance(raw_input, str):
                    input_summary = raw_input[:96]

            if case_name:
                enriched["case_name"] = case_name
                enriched["case_display_name"] = case_name
            elif input_summary:
                enriched["case_display_name"] = input_summary
            elif isinstance(case_id, int):
                enriched["case_display_name"] = f"case#{case_id}"
            else:
                enriched["case_display_name"] = f"item#{enriched.get('id')}"

            if method is not None:
                enriched["method"] = method
            if path is not None:
                enriched["path"] = path
            if input_summary is not None:
                enriched["input_summary"] = input_summary

            if enriched.get("item_type") == "dataset_case":
                request_data = enriched.get("request_data")
                if isinstance(request_data, dict):
                    request_api_case_id = self._extract_int(request_data.get("benchmark_api_case_id"))
                    request_api_case_payload = request_data.get("benchmark_api_request_case")
                    if request_api_case_id is not None:
                        enriched["benchmark_api_case_id"] = request_api_case_id
                    if isinstance(request_api_case_payload, dict):
                        enriched["benchmark_api_request_case"] = request_api_case_payload

                if not isinstance(enriched.get("benchmark_api_request_case"), dict):
                    benchmark_api_case = self._resolve_benchmark_api_case_for_item(
                        item=enriched,
                        dataset_item_record=dataset_item_record,
                        case_record=case_record,
                        suite_case_map=suite_case_map,
                    )
                    if benchmark_api_case is not None:
                        enriched["benchmark_api_case_id"] = benchmark_api_case.get("id")
                        benchmark_input_payload = (
                            benchmark_api_case.get("input_payload")
                            if isinstance(benchmark_api_case.get("input_payload"), dict)
                            else None
                        )
                        if benchmark_input_payload is not None:
                            enriched["benchmark_api_request_case"] = benchmark_input_payload

                score_result = enriched.get("score_result")
                if isinstance(score_result, dict):
                    dimensions = score_result.get("dimensions")
                    if isinstance(dimensions, list):
                        reasons: list[dict[str, str]] = []
                        for dimension in dimensions:
                            if not isinstance(dimension, dict):
                                continue
                            reason = str(dimension.get("reason", "")).strip()
                            if not reason:
                                continue
                            reasons.append(
                                {
                                    "name": str(dimension.get("name", "dimension")),
                                    "reason": reason,
                                }
                            )
                        if reasons:
                            enriched["judge_reason"] = reasons

            if enriched.get("duration_ms") is None and enriched.get("started_at") and enriched.get("finished_at"):
                try:
                    started = datetime.fromisoformat(str(enriched["started_at"]))
                    finished = datetime.fromisoformat(str(enriched["finished_at"]))
                    enriched["duration_ms"] = max(1, int((finished - started).total_seconds() * 1000))
                except ValueError:
                    pass

            enriched_items.append(enriched)
        return enriched_items

    def _resolve_benchmark_api_case_for_item(
        self,
        *,
        item: dict[str, Any],
        dataset_item_record: dict[str, Any] | None,
        case_record: dict[str, Any] | None,
        suite_case_map: dict[int, list[dict[str, Any]]],
    ) -> dict[str, Any] | None:
        if not isinstance(case_record, dict):
            return None
        if self._is_api_case_payload(case_record):
            return case_record

        request_data = item.get("request_data")
        request_api_case_id = None
        if isinstance(request_data, dict):
            request_api_case_id = self._extract_int(request_data.get("benchmark_api_case_id"))
            if request_api_case_id is not None:
                request_case = self.case_repository.get(request_api_case_id)
                if isinstance(request_case, dict) and self._is_api_case_payload(request_case):
                    return request_case

        case_meta = case_record.get("meta_info") if isinstance(case_record.get("meta_info"), dict) else {}
        linked_api_case_id = self._extract_int(case_meta.get("linked_api_case_id"))
        current_case_id = self._extract_int(case_record.get("id"))
        suite_id = self._extract_int(case_record.get("suite_id"))
        generation_batch_id = (
            self._extract_generation_batch_id(dataset_item_record)
            or self._extract_generation_batch_id(case_record)
            or self._extract_generation_batch_id(request_data)
        )

        if current_case_id and suite_id:
            suite_cases = suite_case_map.get(suite_id)
            if suite_cases is None:
                suite_cases = self.case_repository.list({"suite_id": suite_id})
                suite_case_map[suite_id] = suite_cases

            candidates: list[dict[str, Any]] = []
            for candidate in suite_cases:
                if not isinstance(candidate, dict):
                    continue
                if not self._is_api_case_payload(candidate):
                    continue
                candidate_meta = candidate.get("meta_info") if isinstance(candidate.get("meta_info"), dict) else {}
                linked_agent_case_id = self._extract_int(candidate_meta.get("linked_agent_case_id"))
                if linked_agent_case_id != current_case_id:
                    continue
                candidates.append(candidate)

            if generation_batch_id is not None:
                batch_candidates = [
                    candidate
                    for candidate in candidates
                    if self._extract_generation_batch_id(candidate) == generation_batch_id
                ]
                if batch_candidates:
                    candidates = batch_candidates

            if candidates:
                candidates.sort(
                    key=lambda candidate: (
                        self._extract_generation_index(candidate),
                        self._extract_int(candidate.get("id")) or 0,
                    )
                )
                return candidates[0]

        for candidate_id in (request_api_case_id, linked_api_case_id):
            if candidate_id is None:
                continue
            candidate = self.case_repository.get(candidate_id)
            if isinstance(candidate, dict) and self._is_api_case_payload(candidate):
                return candidate
        return None

    @staticmethod
    def _extract_int(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            if value.is_integer():
                return int(value)
            return None
        if isinstance(value, str):
            trimmed = value.strip()
            if not trimmed:
                return None
            try:
                return int(trimmed)
            except ValueError:
                return None
        return None

    def _extract_generation_batch_id(self, payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None
        if isinstance(payload.get("generation_batch_id"), str) and payload.get("generation_batch_id", "").strip():
            return str(payload.get("generation_batch_id")).strip()
        meta_info = payload.get("meta_info")
        if isinstance(meta_info, dict) and isinstance(meta_info.get("generation_batch_id"), str):
            batch_id = str(meta_info.get("generation_batch_id")).strip()
            if batch_id:
                return batch_id
        return None

    @staticmethod
    def _extract_generation_index(case_record: dict[str, Any]) -> int:
        meta_info = case_record.get("meta_info") if isinstance(case_record.get("meta_info"), dict) else {}
        raw_value = meta_info.get("generation_index")
        if isinstance(raw_value, bool):
            return 10**9
        if isinstance(raw_value, int):
            return raw_value
        if isinstance(raw_value, float):
            return int(raw_value) if raw_value.is_integer() else 10**9
        if isinstance(raw_value, str):
            trimmed = raw_value.strip()
            if trimmed.isdigit():
                return int(trimmed)
        return 10**9

    @staticmethod
    def _is_api_case_payload(case_record: dict[str, Any]) -> bool:
        input_payload = case_record.get("input_payload")
        if not isinstance(input_payload, dict):
            return False
        method = input_payload.get("method")
        path = input_payload.get("path")
        return isinstance(method, str) and method.strip() != "" and isinstance(path, str) and path.strip() != ""

    def _failed_case_ids(self, run_id: int) -> set[int]:
        run_items = self.run_item_repository.list({"run_id": run_id})
        return {int(item["case_id"]) for item in run_items if item.get("status") == "failed" and item.get("case_id")}

    def _run_pass_rate(self, run_record: dict[str, Any]) -> float:
        summary = run_record.get("summary") or {}
        total = int(summary.get("total", 0) or 0)
        passed = int(summary.get("passed", 0) or 0)
        if total <= 0:
            return 0.0
        return round((passed / total) * 100, 2)

    def _batch_avg_score(self, run_ids: list[int]) -> dict[int, float]:
        result: dict[int, float] = {}
        for run_id in run_ids:
            items = self.run_item_repository.list({"run_id": run_id})
            scores = []
            for item in items:
                score_result = item.get("score_result")
                if isinstance(score_result, dict):
                    total_score = score_result.get("total_score")
                    if isinstance(total_score, (int, float)):
                        scores.append(float(total_score))
            if scores:
                result[run_id] = round(sum(scores) / len(scores), 4)
        return result

    def _build_pass_rate_point(self, run_record: dict[str, Any]) -> dict[str, Any]:
        return {
            "runId": run_record["id"],
            "createdAt": run_record.get("created_at"),
            "passRate": self._run_pass_rate(run_record),
            "failed": int((run_record.get("summary") or {}).get("failed", 0) or 0),
        }

    def _build_avg_score_point(self, run_record: dict[str, Any], avg_score_by_run: dict[int, float]) -> dict[str, Any]:
        return {
            "runId": run_record["id"],
            "createdAt": run_record.get("created_at"),
            "avgScore": avg_score_by_run.get(run_record["id"], 0.0),
        }

    def _build_failure_distribution(self, api_runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        failed_total = sum(int((run.get("summary") or {}).get("failed", 0) or 0) for run in api_runs)
        passed_total = sum(int((run.get("summary") or {}).get("passed", 0) or 0) for run in api_runs)
        return [
            {"name": "passed", "value": passed_total},
            {"name": "failed", "value": failed_total},
        ]

    def _build_dimension_distribution(self, run_ids: list[int]) -> list[dict[str, Any]]:
        aggregate: dict[str, list[float]] = {}
        for run_id in run_ids:
            run_items = self.run_item_repository.list({"run_id": run_id})
            for item in run_items:
                score_result = item.get("score_result")
                if not isinstance(score_result, dict):
                    continue
                dimensions = score_result.get("dimensions")
                if not isinstance(dimensions, list):
                    continue
                for dimension in dimensions:
                    if not isinstance(dimension, dict):
                        continue
                    name = dimension.get("name")
                    score = dimension.get("score")
                    if isinstance(name, str) and isinstance(score, (int, float)):
                        aggregate.setdefault(name, []).append(float(score))
        return [
            {"dimension": name, "avgScore": round(sum(values) / len(values), 4)}
            for name, values in sorted(aggregate.items(), key=lambda item: item[0])
            if values
        ]

    @staticmethod
    def _normalize_run_type(run_type: Any) -> str:
        if run_type == "benchmark":
            return "agent_eval"
        return str(run_type or "")

    def _suite_trend(self, suite_runs: list[dict[str, Any]]) -> str:
        if len(suite_runs) < 2:
            return "flat"
        ordered = sorted(suite_runs, key=lambda item: item["id"])
        current = self._run_pass_rate(ordered[-1])
        previous = self._run_pass_rate(ordered[-2])
        if current > previous:
            return "up"
        if current < previous:
            return "down"
        return "flat"

    def _top_failed_cases(self, run_ids: list[int], top_n: int = 10) -> list[dict[str, Any]]:
        failed_count: dict[int, int] = {}
        for run_id in run_ids:
            for item in self.run_item_repository.list({"run_id": run_id}):
                case_id = item.get("case_id")
                if item.get("status") != "failed" or not isinstance(case_id, int):
                    continue
                failed_count[case_id] = failed_count.get(case_id, 0) + 1
        result = []
        for case_id, count in sorted(failed_count.items(), key=lambda pair: pair[1], reverse=True)[:top_n]:
            case_item = self.case_repository.get(case_id)
            result.append(
                {
                    "caseId": case_id,
                    "caseName": case_item.get("name") if case_item else f"case#{case_id}",
                    "failedCount": count,
                }
            )
        return result

    def _error_type_distribution(self, run_ids: list[int]) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for run_id in run_ids:
            for item in self.run_item_repository.list({"run_id": run_id}):
                error_info = item.get("error_info")
                if not isinstance(error_info, dict):
                    continue
                error_type = error_info.get("type")
                if not isinstance(error_type, str) or not error_type:
                    error_type = "unknown"
                counts[error_type] = counts.get(error_type, 0) + 1
        return [{"name": name, "value": value} for name, value in sorted(counts.items(), key=lambda item: item[1], reverse=True)]

    def _build_api_quality_profile(self, api_runs: list[dict[str, Any]], slow_threshold_ms: int = 3000) -> dict[str, Any]:
        run_ids = [run["id"] for run in api_runs]
        items: list[dict[str, Any]] = []
        for run_id in run_ids:
            items.extend(self.run_item_repository.list({"run_id": run_id}))

        item_count = len(items)
        failed_items = [item for item in items if str(item.get("status") or "").lower() == "failed"]
        failed_item_count = len(failed_items)
        failed_case_ids = {
            case_id
            for case_id in (item.get("case_id") for item in failed_items)
            if isinstance(case_id, int)
        }

        retry_hit_count = sum(1 for item in items if isinstance(item.get("retry_count"), int) and int(item.get("retry_count", 0)) > 0)
        timeout_count = sum(1 for item in items if self._is_timeout_error(item.get("error_info")))

        duration_values = [
            float(item.get("duration_ms"))
            for item in items
            if isinstance(item.get("duration_ms"), (int, float)) and float(item.get("duration_ms")) > 0
        ]
        slow_request_count = sum(1 for value in duration_values if value >= slow_threshold_ms)

        status_code_distribution = self._status_code_distribution(items)
        flaky_cases = self._flaky_case_distribution(items)
        top_slow_cases = self._top_slow_cases(items)

        latest_api_run = max(api_runs, key=lambda item: item["id"]) if api_runs else None
        latest_summary = latest_api_run.get("summary") if isinstance(latest_api_run, dict) and isinstance(latest_api_run.get("summary"), dict) else {}

        return {
            "qualitySummary": {
                "runCount": len(api_runs),
                "itemCount": item_count,
                "failedItemCount": failed_item_count,
                "failedCaseCount": len(failed_case_ids),
                "errorTypeCount": len(self._error_type_distribution(run_ids)),
                "statusCodeTypeCount": len(status_code_distribution),
                "retryHitCount": retry_hit_count,
                "retryRate": round((retry_hit_count / item_count) * 100, 1) if item_count > 0 else 0.0,
                "timeoutCount": timeout_count,
                "timeoutRate": round((timeout_count / item_count) * 100, 1) if item_count > 0 else 0.0,
                "slowRequestCount": slow_request_count,
                "slowRequestRate": round((slow_request_count / item_count) * 100, 1) if item_count > 0 else 0.0,
                "avgDurationMs": round(sum(duration_values) / len(duration_values), 1) if duration_values else 0.0,
                "p95DurationMs": round(self._percentile(duration_values, 0.95), 1) if duration_values else 0.0,
                "flakyCaseCount": len(flaky_cases),
                "slowThresholdMs": slow_threshold_ms,
            },
            "latestRunInsight": {
                "runId": latest_api_run.get("id") if latest_api_run else None,
                "passRate": self._run_pass_rate(latest_api_run) if latest_api_run else 0.0,
                "failed": int((latest_summary or {}).get("failed", 0) or 0),
                "total": int((latest_summary or {}).get("total", 0) or 0),
            },
            "statusCodeDistribution": status_code_distribution,
            "topSlowCases": top_slow_cases,
            "flakyCases": flaky_cases,
        }

    def _top_slow_cases(self, items: list[dict[str, Any]], top_n: int = 5) -> list[dict[str, Any]]:
        case_name_cache: dict[int, str] = {}
        aggregate: dict[tuple[str, int], dict[str, Any]] = {}

        for item in items:
            raw_duration = item.get("duration_ms")
            if not isinstance(raw_duration, (int, float)) or float(raw_duration) <= 0:
                continue
            case_id = item.get("case_id")
            item_id = item.get("id")
            key = ("case", case_id) if isinstance(case_id, int) else ("item", item_id if isinstance(item_id, int) else -1)

            if isinstance(case_id, int):
                if case_id not in case_name_cache:
                    case_item = self.case_repository.get(case_id)
                    case_name_cache[case_id] = case_item.get("name") if case_item else f"case#{case_id}"
                case_name = case_name_cache[case_id]
            else:
                case_name = f"item#{item_id}" if isinstance(item_id, int) else "未命名样本"

            entry = aggregate.setdefault(
                key,
                {
                    "caseId": case_id if isinstance(case_id, int) else None,
                    "caseName": case_name,
                    "durations": [],
                },
            )
            entry["durations"].append(float(raw_duration))

        ranked = []
        for value in aggregate.values():
            durations = value.get("durations", [])
            if not isinstance(durations, list) or not durations:
                continue
            ranked.append(
                {
                    "caseId": value.get("caseId"),
                    "caseName": value.get("caseName"),
                    "sampleCount": len(durations),
                    "avgDurationMs": round(sum(durations) / len(durations), 1),
                    "p95DurationMs": round(self._percentile(durations, 0.95), 1),
                }
            )

        ranked.sort(key=lambda item: (item["avgDurationMs"], item["sampleCount"]), reverse=True)
        return ranked[:top_n]

    def _flaky_case_distribution(self, items: list[dict[str, Any]], top_n: int = 5) -> list[dict[str, Any]]:
        case_name_cache: dict[int, str] = {}
        aggregate: dict[int, dict[str, int]] = {}

        for item in items:
            case_id = item.get("case_id")
            if not isinstance(case_id, int):
                continue
            status = str(item.get("status") or "").lower()
            if status not in {"success", "failed"}:
                continue
            bucket = aggregate.setdefault(case_id, {"passCount": 0, "failCount": 0})
            if status == "success":
                bucket["passCount"] += 1
            else:
                bucket["failCount"] += 1

        flaky_rows = []
        for case_id, bucket in aggregate.items():
            pass_count = bucket["passCount"]
            fail_count = bucket["failCount"]
            if pass_count == 0 or fail_count == 0:
                continue
            total = pass_count + fail_count
            if case_id not in case_name_cache:
                case_item = self.case_repository.get(case_id)
                case_name_cache[case_id] = case_item.get("name") if case_item else f"case#{case_id}"
            flaky_rows.append(
                {
                    "caseId": case_id,
                    "caseName": case_name_cache[case_id],
                    "passCount": pass_count,
                    "failCount": fail_count,
                    "flakyIndex": round((min(pass_count, fail_count) / total) * 100, 1),
                }
            )

        flaky_rows.sort(key=lambda item: (item["flakyIndex"], item["failCount"] + item["passCount"]), reverse=True)
        return flaky_rows[:top_n]

    def _status_code_distribution(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for item in items:
            response_data = item.get("response_data")
            if not isinstance(response_data, dict):
                continue
            status_code = self._normalize_status_code(response_data.get("status_code"))
            if status_code is None:
                continue
            status_key = str(status_code)
            counts[status_key] = counts.get(status_key, 0) + 1
        return [{"name": name, "value": value} for name, value in sorted(counts.items(), key=lambda item: item[1], reverse=True)]

    @staticmethod
    def _normalize_status_code(raw_value: Any) -> int | None:
        if isinstance(raw_value, bool):
            return None
        if isinstance(raw_value, int):
            return raw_value if 100 <= raw_value <= 599 else None
        if isinstance(raw_value, float):
            if not raw_value.is_integer():
                return None
            candidate = int(raw_value)
            return candidate if 100 <= candidate <= 599 else None
        if isinstance(raw_value, str):
            trimmed = raw_value.strip()
            if trimmed.isdigit():
                candidate = int(trimmed)
                return candidate if 100 <= candidate <= 599 else None
        return None

    @staticmethod
    def _is_timeout_error(error_info: Any) -> bool:
        if not isinstance(error_info, dict):
            return False
        type_text = str(error_info.get("type") or "").lower()
        message_text = str(error_info.get("message") or "").lower()
        return "timeout" in type_text or "timeout" in message_text or "timed out" in message_text

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float:
        if not values:
            return 0.0
        if len(values) == 1:
            return values[0]
        ordered = sorted(values)
        rank = max(0.0, min(1.0, percentile)) * (len(ordered) - 1)
        lower = int(math.floor(rank))
        upper = int(math.ceil(rank))
        if lower == upper:
            return ordered[lower]
        weight = rank - lower
        return ordered[lower] + (ordered[upper] - ordered[lower]) * weight

    def _dimension_trend(self, run_ids: list[int]) -> list[dict[str, Any]]:
        points = []
        for run_id in run_ids:
            dimensions = self._build_dimension_distribution([run_id])
            points.append({"runId": run_id, "dimensions": dimensions})
        return points

    def _low_score_cases(self, run_ids: list[int], threshold: float = 0.8) -> list[dict[str, Any]]:
        low_score_items = []
        for run_id in run_ids:
            for item in self.run_item_repository.list({"run_id": run_id}):
                score_result = item.get("score_result")
                if not isinstance(score_result, dict):
                    continue
                total_score = score_result.get("total_score")
                if not isinstance(total_score, (int, float)) or float(total_score) >= threshold:
                    continue
                case_id = item.get("case_id")
                case_item = self.case_repository.get(case_id) if isinstance(case_id, int) else None
                low_score_items.append(
                    {
                        "runId": run_id,
                        "caseId": case_id,
                        "caseName": case_item.get("name") if case_item else f"case#{case_id}" if case_id else f"item#{item.get('id')}",
                        "score": round(float(total_score), 4),
                    }
                )
        low_score_items.sort(key=lambda item: item["score"])
        return low_score_items[:20]

    def _compare_metrics(self, run_1: dict[str, Any], run_2: dict[str, Any]) -> dict[str, Any]:
        run_type = run_2.get("run_type") or run_1.get("run_type")
        if run_type == "agent_eval":
            avg_scores = self._batch_avg_score([run_1["id"], run_2["id"]])
            dimensions_1 = self._build_dimension_distribution([run_1["id"]])
            dimensions_2 = self._build_dimension_distribution([run_2["id"]])
            return {
                "avgScore1": avg_scores.get(run_1["id"], 0.0),
                "avgScore2": avg_scores.get(run_2["id"], 0.0),
                "avgScoreDelta": round(avg_scores.get(run_2["id"], 0.0) - avg_scores.get(run_1["id"], 0.0), 4),
                "dimensions1": dimensions_1,
                "dimensions2": dimensions_2,
            }
        return {
            "passRate1": self._run_pass_rate(run_1),
            "passRate2": self._run_pass_rate(run_2),
            "passRateDelta": round(self._run_pass_rate(run_2) - self._run_pass_rate(run_1), 2),
            "failed1": int((run_1.get("summary") or {}).get("failed", 0) or 0),
            "failed2": int((run_2.get("summary") or {}).get("failed", 0) or 0),
        }

    def _build_run_report_html(self, report: dict[str, Any]) -> str:
        summary = report.get("summary") or {}
        return f"""
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Run {report.get('runId')} Report</title>
    <style>
      body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; color: #1f2527; }}
      h1 {{ margin: 0 0 12px; }}
      .card {{ border: 1px solid #dde3e6; border-radius: 10px; padding: 12px; margin-bottom: 12px; }}
      pre {{ white-space: pre-wrap; word-break: break-word; background: #f6f8f9; padding: 10px; border-radius: 8px; }}
    </style>
  </head>
  <body>
    <h1>Run {report.get("runId")} 报告</h1>
    <div class="card">
      <div>Run Type: {report.get("runType")}</div>
      <div>Status: {report.get("status")}</div>
      <div>Total: {summary.get("total", 0)} | Passed: {summary.get("passed", 0)} | Failed: {summary.get("failed", 0)}</div>
    </div>
    <div class="card">
      <h3>Overview</h3>
      <pre>{self._to_jsonable(report.get("overview"))}</pre>
    </div>
    <div class="card">
      <h3>Comparison</h3>
      <pre>{self._to_jsonable(report.get("comparison"))}</pre>
    </div>
  </body>
</html>
""".strip()

    def _persist_report(self, run_id: int, report_type: str, title: str, content_json: dict[str, Any]) -> None:
        self.report_record_repository.create(
            {
                "run_id": run_id,
                "report_type": report_type,
                "title": title,
                "content_json": self._to_jsonable(content_json),
                "file_url": None,
            }
        )

    def _to_jsonable(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {key: self._to_jsonable(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._to_jsonable(item) for item in value]
        if isinstance(value, set):
            return [self._to_jsonable(item) for item in sorted(value)]
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        return value
