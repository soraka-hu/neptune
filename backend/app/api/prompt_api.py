from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import Field

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.asset_service import AssetService


class CreatePromptTemplateRequest(ApiModel):
    name: str
    template_type: str
    content: str
    variables_schema: dict[str, Any] | None = None
    model_config_data: dict[str, Any] | None = Field(default=None, alias="modelConfig")
    status: str = "active"
    version: int = 1


class UpdatePromptTemplateRequest(ApiModel):
    name: str | None = None
    template_type: str | None = None
    content: str | None = None
    variables_schema: dict[str, Any] | None = None
    model_config_data: dict[str, Any] | None = Field(default=None, alias="modelConfig")
    status: str | None = None
    version: int | None = None


router = APIRouter()


@router.post("/api/prompts")
def create_prompt_template(payload: CreatePromptTemplateRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        payload_data = payload.model_dump(exclude_none=True)
        if "model_config_data" in payload_data:
            payload_data["model_config"] = payload_data.pop("model_config_data")
        data = AssetService().create_prompt_template(payload_data)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/prompts")
def list_prompt_templates(request: Request):
    request_id = request_id_from_request(request)
    data = AssetService().list_prompt_templates()
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/prompts/{prompt_id}")
def get_prompt_template(prompt_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().get_prompt_template(prompt_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/prompts/{prompt_id}")
def update_prompt_template(prompt_id: int, payload: UpdatePromptTemplateRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        payload_data = payload.model_dump(exclude_none=True)
        if "model_config_data" in payload_data:
            payload_data["model_config"] = payload_data.pop("model_config_data")
        data = AssetService().update_prompt_template(prompt_id, payload_data)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/prompts/{prompt_id}")
def delete_prompt_template(prompt_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = AssetService().delete_prompt_template(prompt_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
