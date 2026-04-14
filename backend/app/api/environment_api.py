from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.pagination import apply_order, build_list_payload
from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreateEnvironmentRequest(ApiModel):
    project_id: int
    name: str
    env_type: str
    base_url: str | None = None
    headers: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None
    secrets_ref: dict[str, Any] | None = None
    status: str = "active"


class UpdateEnvironmentRequest(ApiModel):
    project_id: int | None = None
    name: str | None = None
    env_type: str | None = None
    base_url: str | None = None
    headers: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None
    secrets_ref: dict[str, Any] | None = None
    status: str | None = None


router = APIRouter()


@router.post("/api/environments")
def create_environment(payload: CreateEnvironmentRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().create_environment(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/environments")
def list_environments(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    env_type: str | None = Query(default=None, alias="envType"),
    keyword: str | None = Query(default=None),
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, alias="pageSize", ge=1),
    order: str = Query(default="asc"),
):
    request_id = request_id_from_request(request)
    data = AssetService().list_environments(project_id=project_id)

    if env_type:
        data = [item for item in data if str(item.get("env_type") or "") == env_type]

    normalized_keyword = (keyword or "").strip().lower()
    if normalized_keyword:
        data = [
            item
            for item in data
            if normalized_keyword in str(item.get("name") or "").lower()
            or normalized_keyword in str(item.get("base_url") or "").lower()
        ]

    try:
        ordered = apply_order(data, order)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(build_list_payload(ordered, page=page, page_size=page_size), request_id=request_id)


@router.put("/api/environments/{environment_id}")
def update_environment(environment_id: int, payload: UpdateEnvironmentRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().update_environment(environment_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/environments/{environment_id}")
def delete_environment(environment_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_environment(environment_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/environments/{environment_id}/ping")
def ping_environment(environment_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_environment(environment_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(
        {"environmentId": environment_id, "reachable": bool(data.get("base_url")), "baseUrl": data.get("base_url")},
        request_id=request_id,
    )
