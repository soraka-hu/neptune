from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreateDatasetRequest(ApiModel):
    project_id: int
    name: str
    description: str | None = None
    dataset_type: str
    schema_definition: dict[str, Any] | None = None
    generation_config: dict[str, Any] | None = None
    status: str = "draft"
    version: int = 1


class UpdateDatasetRequest(ApiModel):
    name: str | None = None
    description: str | None = None
    dataset_type: str | None = None
    schema_definition: dict[str, Any] | None = None
    generation_config: dict[str, Any] | None = None
    status: str | None = None
    version: int | None = None


class DatasetItemsRequest(ApiModel):
    items: list[dict[str, Any]]


class CreateDatasetItemRequest(ApiModel):
    input_data: dict[str, Any]
    reference_answer: dict[str, Any] | None = None
    meta_info: dict[str, Any] | None = None
    status: str = "active"


router = APIRouter()


@router.post("/api/datasets")
def create_dataset(payload: CreateDatasetRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().create_dataset(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/datasets")
def list_datasets(request: Request, project_id: int | None = Query(default=None, alias="projectId")):
    request_id = request_id_from_request(request)
    data = AssetService().list_datasets(project_id=project_id)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_dataset(dataset_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/datasets/{dataset_id}")
def update_dataset(dataset_id: int, payload: UpdateDatasetRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().update_dataset(dataset_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/datasets/{dataset_id}")
def delete_dataset(dataset_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_dataset(dataset_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/datasets/{dataset_id}/items")
def create_dataset_item(dataset_id: int, payload: CreateDatasetItemRequest, request: Request):
    request_id = request_id_from_request(request)
    data = AssetService().add_dataset_item(dataset_id, payload.model_dump(exclude_none=True))
    return build_success_response(data, request_id=request_id)


@router.post("/api/datasets/{dataset_id}/items/import")
def import_dataset_items(dataset_id: int, payload: DatasetItemsRequest, request: Request):
    request_id = request_id_from_request(request)
    data = AssetService().import_dataset_items(dataset_id, payload.items)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/datasets/items/{item_id}")
def delete_dataset_item(item_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_dataset_item(item_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/datasets/generate")
def generate_dataset(payload: dict[str, Any], request: Request):
    request_id = request_id_from_request(request)
    return build_success_response({"taskId": f"dataset_gen_{payload.get('projectId', 'unknown')}"}, request_id=request_id)
