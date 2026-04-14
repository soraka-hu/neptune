from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreateEvaluatorRequest(ApiModel):
    name: str
    evaluator_type: str
    description: str | None = None
    config: dict[str, Any]
    status: str = "active"
    version: int = 1


class UpdateEvaluatorRequest(ApiModel):
    name: str | None = None
    evaluator_type: str | None = None
    description: str | None = None
    config: dict[str, Any] | None = None
    status: str | None = None
    version: int | None = None


router = APIRouter()


@router.post("/api/evaluators")
def create_evaluator(payload: CreateEvaluatorRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().create_evaluator(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/evaluators")
def list_evaluators(request: Request):
    request_id = request_id_from_request(request)
    data = AssetService().list_evaluators()
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/evaluators/{evaluator_id}")
def get_evaluator(evaluator_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_evaluator(evaluator_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/evaluators/{evaluator_id}")
def update_evaluator(evaluator_id: int, payload: UpdateEvaluatorRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().update_evaluator(evaluator_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/evaluators/{evaluator_id}")
def delete_evaluator(evaluator_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_evaluator(evaluator_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
