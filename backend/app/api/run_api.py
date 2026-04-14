from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.pagination import apply_order, build_list_payload
from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.run_service import RunService


class ApiRunRequest(ApiModel):
    project_id: int
    suite_id: int
    environment_id: int
    dataset_id: int | None = None
    rule_ids: list[int] | None = None
    execution_rule_id: int | None = None
    execution_config: dict[str, Any] | None = None
    trigger_type: str = "manual"
    source_id: int | None = None
    created_by: int | None = None


class AgentEvalRunRequest(ApiModel):
    project_id: int
    suite_id: int
    dataset_id: int
    environment_id: int
    rule_ids: list[int] | None = None
    scoring_rule_id: int | None = None
    execution_config: dict[str, Any] | None = None
    evaluation_mode: str = "with_reference"
    trigger_type: str = "manual"
    source_id: int | None = None
    created_by: int | None = None


class CreateRunRequest(ApiModel):
    run_type: str
    project_id: int
    suite_id: int
    environment_id: int
    dataset_id: int | None = None
    rule_ids: list[int] | None = None
    execution_rule_id: int | None = None
    scoring_rule_id: int | None = None
    execution_config: dict[str, Any] | None = None
    evaluation_mode: str = "with_reference"
    trigger_type: str = "manual"
    source_id: int | None = None
    created_by: int | None = None


class RulePreviewRequest(ApiModel):
    run_type: str
    project_id: int
    suite_id: int | None = None
    rule_ids: list[int] | None = None
    execution_rule_id: int | None = None
    scoring_rule_id: int | None = None
    execution_config: dict[str, Any] | None = None


router = APIRouter()


def _idempotency_key(request: Request) -> str | None:
    return request.headers.get("Idempotency-Key")


def _normalize_run_type(value: str | None) -> str | None:
    if value in {"api_test", "agent_eval"}:
        return value
    if value == "benchmark":
        return "agent_eval"
    return value


def _within_time_range(created_at: str | None, time_range: str) -> bool:
    if time_range == "all" or not created_at:
        return True
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    now = datetime.now(created.tzinfo) if created.tzinfo is not None else datetime.now()
    delta = now - created
    if time_range == "24h":
        return delta <= timedelta(hours=24)
    if time_range == "7d":
        return delta <= timedelta(days=7)
    if time_range == "30d":
        return delta <= timedelta(days=30)
    return True


@router.post("/api/runs")
def create_run(payload: CreateRunRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().create_run(
            {**payload.model_dump(exclude_none=True), "run_type": _normalize_run_type(payload.run_type)},
            _idempotency_key(request),
        )
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/runs/api")
def create_api_run(payload: ApiRunRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().create_api_run(payload.model_dump(exclude_none=True), _idempotency_key(request))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/runs/agent-eval")
def create_agent_eval_run(payload: AgentEvalRunRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().create_agent_eval_run(payload.model_dump(exclude_none=True), _idempotency_key(request))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/runs/rule-preview")
def preview_run_rule_binding(payload: RulePreviewRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().preview_rule_binding(
            {**payload.model_dump(exclude_none=True), "run_type": _normalize_run_type(payload.run_type)}
        )
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/runs/{run_id}")
def get_run(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().get_run(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/runs")
def list_runs(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    suite_id: int | None = Query(default=None, alias="suiteId"),
    status: str | None = Query(default=None),
    run_type: str | None = Query(default=None, alias="runType"),
    time_range: str = Query(default="all", alias="timeRange"),
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, alias="pageSize", ge=1),
    order: str = Query(default="asc"),
):
    request_id = request_id_from_request(request)
    if time_range not in {"all", "24h", "7d", "30d"}:
        return build_error_response(status_code=400, message="timeRange must be one of all, 24h, 7d, 30d", request_id=request_id)
    data = RunService().list_runs(
        project_id=project_id,
        suite_id=suite_id,
        status=status,
        run_type=_normalize_run_type(run_type),
    )
    if time_range != "all":
        data = [item for item in data if _within_time_range(item.get("created_at"), time_range)]
    try:
        ordered = apply_order(data, order)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(build_list_payload(ordered, page=page, page_size=page_size), request_id=request_id)


@router.get("/api/runs/{run_id}/items")
def list_run_items(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().list_run_items(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/runs/{run_id}/logs")
def list_run_logs(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().list_run_logs(run_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/runs/{run_id}/compare")
def compare_run(
    run_id: int,
    request: Request,
    target_run_id: int | None = Query(default=None, alias="targetRunId"),
):
    request_id = request_id_from_request(request)
    try:
        data = RunService().compare_run(run_id, target_run_id)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().cancel_run(run_id)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/runs/{run_id}/retry-failed")
def retry_failed_run(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().retry_failed(run_id)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/runs/{run_id}")
def delete_run(run_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunService().delete_run(run_id)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
