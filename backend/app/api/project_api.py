from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app.api.pagination import apply_order, build_list_payload
from app.application.project_service import NotFoundError, ProjectService


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def request_id_from_request(request: Request) -> str:
    return request.headers.get("X-Request-ID") or uuid4().hex


def build_success_response(data: Any = None, *, request_id: str, message: str = "success", code: int = 0) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "code": code,
            "message": message,
            "requestId": request_id,
            "data": {} if data is None else jsonable_encoder(data),
        },
    )


def build_error_response(
    *,
    status_code: int,
    message: str,
    request_id: str,
    code: int = 4001001,
    data: Any = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "code": code,
            "message": message,
            "requestId": request_id,
            "data": {} if data is None else jsonable_encoder(data),
        },
    )


class CreateProjectRequest(ApiModel):
    name: str
    project_type: str
    description: str | None = None


class UpdateProjectRequest(ApiModel):
    name: str | None = None
    project_type: str | None = None
    description: str | None = None
    status: str | None = None


router = APIRouter()


@router.post("/api/projects")
def create_project(payload: CreateProjectRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ProjectService().create_project(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/projects")
def list_projects(
    request: Request,
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, alias="pageSize", ge=1),
    order: str = Query(default="asc"),
):
    request_id = request_id_from_request(request)
    data = ProjectService().list_projects()
    try:
        ordered = apply_order(data, order)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(build_list_payload(ordered, page=page, page_size=page_size), request_id=request_id)


@router.get("/api/projects/{project_id}")
def get_project(project_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ProjectService().get_project(project_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/projects/{project_id}")
def update_project(project_id: int, payload: UpdateProjectRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ProjectService().update_project(project_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/projects/{project_id}/archive")
def archive_project(project_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ProjectService().archive_project(project_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)
