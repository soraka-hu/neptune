from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.api.pagination import apply_order, build_list_payload
from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreateSuiteRequest(ApiModel):
    project_id: int
    name: str
    description: str | None = None
    suite_type: str
    status: str = "active"
    version: int = 1
    tags: dict | None = None


class UpdateSuiteRequest(ApiModel):
    name: str | None = None
    description: str | None = None
    suite_type: str | None = None
    status: str | None = None
    version: int | None = None
    tags: dict | None = None


router = APIRouter()


@router.post("/api/suites")
def create_suite(payload: CreateSuiteRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().create_suite(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/suites")
def list_suites(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    suite_type: str | None = Query(default=None, alias="suiteType"),
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, alias="pageSize", ge=1),
    order: str = Query(default="asc"),
):
    request_id = request_id_from_request(request)
    data = AssetService().list_suites(project_id=project_id, suite_type=suite_type)
    try:
        ordered = apply_order(data, order)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(build_list_payload(ordered, page=page, page_size=page_size), request_id=request_id)


@router.get("/api/suite-asset-overview")
def list_suite_asset_overview(
    request: Request,
    project_id: int = Query(alias="projectId"),
    case_type: str = Query(default="api", alias="caseType"),
):
    request_id = request_id_from_request(request)
    if case_type not in {"api", "agent"}:
        return build_error_response(
            status_code=400,
            message="caseType must be one of: api, agent",
            request_id=request_id,
        )
    data = AssetService().list_suite_asset_overview(project_id=project_id, case_type=case_type)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/suites/{suite_id}")
def get_suite(suite_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_suite(suite_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/suites/{suite_id}")
def update_suite(suite_id: int, payload: UpdateSuiteRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().update_suite(suite_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/suites/{suite_id}")
def delete_suite(suite_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_suite(suite_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
