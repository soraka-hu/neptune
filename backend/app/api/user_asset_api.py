from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.pagination import apply_order, build_list_payload
from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreateUserAssetRequest(ApiModel):
    project_id: int
    suite_id: int | None = None
    asset_type: str
    name: str
    file_name: str | None = None
    content_text: str | None = None
    file_base64: str | None = None
    content_json: dict[str, Any] | None = None
    meta_info: dict[str, Any] | None = None
    status: str = "active"


class UpdateUserAssetRequest(ApiModel):
    project_id: int | None = None
    suite_id: int | None = None
    asset_type: str | None = None
    name: str | None = None
    file_name: str | None = None
    content_text: str | None = None
    content_json: dict[str, Any] | None = None
    meta_info: dict[str, Any] | None = None
    status: str | None = None


router = APIRouter()


@router.post("/api/user-assets")
def create_user_asset(payload: CreateUserAssetRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().create_user_asset(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/user-assets")
def list_user_assets(
    request: Request,
    project_id: int | None = Query(default=None, alias="projectId"),
    suite_id: int | None = Query(default=None, alias="suiteId"),
    asset_type: str | None = Query(default=None, alias="assetType"),
    status: str | None = Query(default=None),
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, alias="pageSize", ge=1),
    order: str = Query(default="asc"),
):
    request_id = request_id_from_request(request)
    data = AssetService().list_user_assets(
        project_id=project_id,
        suite_id=suite_id,
        asset_type=asset_type,
        status=status,
    )
    try:
        ordered = apply_order(data, order)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(build_list_payload(ordered, page=page, page_size=page_size), request_id=request_id)


@router.get("/api/user-assets/{asset_id}")
def get_user_asset(asset_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_user_asset(asset_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/user-assets/{asset_id}")
def update_user_asset(asset_id: int, payload: UpdateUserAssetRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().update_user_asset(asset_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/user-assets/{asset_id}")
def delete_user_asset(asset_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_user_asset(asset_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
