from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreateCaseRequest(ApiModel):
    project_id: int
    suite_id: int | None = None
    name: str
    description: str | None = None
    case_type: str
    source_type: str = "manual"
    status: str = "draft"
    priority: str = "P2"
    version: int = 1
    input_payload: dict[str, Any]
    expected_output: dict[str, Any] | None = None
    assertion_config: dict[str, Any] | None = None
    eval_config: dict[str, Any] | None = None
    meta_info: dict[str, Any] | None = None


class UpdateCaseRequest(ApiModel):
    suite_id: int | None = None
    name: str | None = None
    description: str | None = None
    case_type: str | None = None
    source_type: str | None = None
    status: str | None = None
    priority: str | None = None
    version: int | None = None
    input_payload: dict[str, Any] | None = None
    expected_output: dict[str, Any] | None = None
    assertion_config: dict[str, Any] | None = None
    eval_config: dict[str, Any] | None = None
    meta_info: dict[str, Any] | None = None


router = APIRouter()


@router.post("/api/cases")
def create_case(payload: CreateCaseRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().create_case(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/cases")
def list_cases(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    suite_id: int | None = Query(default=None, alias="suiteId"),
    case_type: str | None = Query(default=None, alias="caseType"),
):
    request_id = request_id_from_request(request)
    data = AssetService().list_cases(project_id=project_id, suite_id=suite_id, case_type=case_type)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/cases/{case_id}")
def get_case(case_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_case(case_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/cases/{case_id}")
def update_case(case_id: int, payload: UpdateCaseRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().update_case(case_id, payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/cases/{case_id}")
def delete_case(case_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_case(case_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/cases/{case_id}/duplicate")
def duplicate_case(case_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().duplicate_case(case_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/cases/{case_id}/status")
def change_case_status(case_id: int, payload: dict[str, Any], request: Request):
    request_id = request_id_from_request(request)
    status = payload.get("status")
    if not status:
        return build_error_response(status_code=400, message="missing status", request_id=request_id)
    try:
        data = AssetService().change_case_status(case_id, status)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
