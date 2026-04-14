from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.run_schedule_service import RunScheduleService


class CreateRunScheduleRequest(ApiModel):
    name: str
    run_type: str
    project_id: int
    suite_id: int | None = None
    environment_id: int
    dataset_id: int | None = None
    rule_ids: list[int] | None = None
    daily_time: str = "09:00"
    evaluation_mode: str = "with_reference"
    next_run_at: datetime | None = None
    report_delivery: dict[str, Any] | None = None
    status: str = "active"
    created_by: int | None = None


class UpdateRunScheduleRequest(ApiModel):
    name: str | None = None
    run_type: str | None = None
    project_id: int | None = None
    suite_id: int | None = None
    environment_id: int | None = None
    dataset_id: int | None = None
    rule_ids: list[int] | None = None
    daily_time: str | None = None
    evaluation_mode: str | None = None
    next_run_at: datetime | None = None
    report_delivery: dict[str, Any] | None = None
    status: str | None = None
    updated_by: int | None = None


class SetScheduleStatusRequest(ApiModel):
    status: str


class TriggerScheduleRequest(ApiModel):
    trigger_type: str = "manual"


router = APIRouter()


def _normalize_run_type(value: str | None) -> str | None:
    if value is None:
        return None
    if value == "benchmark":
        return "agent_eval"
    return value


@router.post("/api/run-schedules")
def create_run_schedule(payload: CreateRunScheduleRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunScheduleService().create_schedule(
            {**payload.model_dump(exclude_none=True), "run_type": _normalize_run_type(payload.run_type)}
        )
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/run-schedules")
def list_run_schedules(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    suite_id: int | None = Query(default=None, alias="suiteId"),
    status: str | None = Query(default=None),
    run_type: str | None = Query(default=None, alias="runType"),
):
    request_id = request_id_from_request(request)
    data = RunScheduleService().list_schedules(
        project_id=project_id,
        suite_id=suite_id,
        status=status,
        run_type=_normalize_run_type(run_type),
    )
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/run-schedules/{schedule_id}")
def get_run_schedule(schedule_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunScheduleService().get_schedule(schedule_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/run-schedules/{schedule_id}")
def update_run_schedule(schedule_id: int, payload: UpdateRunScheduleRequest, request: Request):
    request_id = request_id_from_request(request)
    raw_payload: dict[str, Any] = payload.model_dump(exclude_none=True)
    if "run_type" in raw_payload:
        raw_payload["run_type"] = _normalize_run_type(str(raw_payload.get("run_type")))
    try:
        data = RunScheduleService().update_schedule(schedule_id, raw_payload)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/run-schedules/{schedule_id}/status")
def set_run_schedule_status(schedule_id: int, payload: SetScheduleStatusRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunScheduleService().set_status(schedule_id, payload.status)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/run-schedules/{schedule_id}/trigger")
def trigger_run_schedule(schedule_id: int, payload: TriggerScheduleRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunScheduleService().trigger_schedule(schedule_id, trigger_type=payload.trigger_type)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/run-schedules/{schedule_id}")
def delete_run_schedule(schedule_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RunScheduleService().delete_schedule(schedule_id)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
