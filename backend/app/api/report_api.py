from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.api.project_api import (
    NotFoundError,
    build_error_response,
    build_success_response,
    request_id_from_request,
)
from app.application.report_service import ReportService


router = APIRouter()


@router.get("/api/reports/run/{run_id}")
def get_run_summary_report(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().get_run_report(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/reports/run/{run_id}/detail")
def get_run_detail_report(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().get_run_detail_report(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/reports/compare")
def compare_run_reports(
    request: Request,
    run_id_1: int = Query(alias="runId1"),
    run_id_2: int = Query(alias="runId2"),
):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().compare_runs(run_id_1, run_id_2)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/reports/run/{run_id}/export")
def export_run_report(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().export_run_report(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/reports/run/{run_id}/export-html")
def export_run_report_html(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().export_run_report_html(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/reports/project/{project_id}")
def get_project_dashboard_report(project_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().get_project_dashboard_report(project_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/reports/dashboard/v1")
def get_dashboard_v1_report(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    time_range: str = Query(default="7d", alias="timeRange"),
    report_type: str = Query(default="all", alias="type"),
    environment: str = Query(default="all"),
    model: str = Query(default="all"),
):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().get_dashboard_v1_report(
            project_id=project_id,
            time_range=time_range,
            report_type=report_type,
            environment=environment,
            model=model,
        )
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/reports/dashboard/v1/export-markdown")
def export_dashboard_v1_markdown_report(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    time_range: str = Query(default="7d", alias="timeRange"),
    report_type: str = Query(default="all", alias="type"),
    environment: str = Query(default="all"),
    model: str = Query(default="all"),
):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().export_dashboard_v1_markdown_report(
            project_id=project_id,
            time_range=time_range,
            report_type=report_type,
            environment=environment,
            model=model,
        )
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/reports/dashboard/v1/export-image")
def export_dashboard_v1_image(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    time_range: str = Query(default="7d", alias="timeRange"),
    report_type: str = Query(default="all", alias="type"),
    environment: str = Query(default="all"),
    model: str = Query(default="all"),
):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().export_dashboard_v1_image(
            project_id=project_id,
            time_range=time_range,
            report_type=report_type,
            environment=environment,
            model=model,
        )
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/reports/suite/{suite_id}")
def get_suite_analytics_report(suite_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().get_suite_analytics_report(suite_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/reports/suite/{suite_id}/export-markdown")
def export_suite_markdown_report(suite_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ReportService().export_suite_markdown_report(suite_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
