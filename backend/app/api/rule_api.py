from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.rule_service import RuleService


class CreateRuleRequest(ApiModel):
    name: str
    rule_type: str
    description: str | None = None
    content: dict[str, Any]
    status: str = "active"
    version: int = 1


class UpdateRuleRequest(ApiModel):
    name: str | None = None
    rule_type: str | None = None
    description: str | None = None
    content: dict[str, Any] | None = None
    status: str | None = None
    version: int | None = None


class BindProjectsRequest(ApiModel):
    project_ids: list[int]


class BindSuitesRequest(ApiModel):
    suite_ids: list[int]


class GenerateAgentScoringRulesRequest(ApiModel):
    project_id: int
    suite_id: int | None = None
    agent_description: str
    user_requirement: str | None = None
    dimensions: list[str] | None = None
    with_reference: bool = True
    count: int = 3
    model: str | None = None
    rule_note: str | None = None
    bind_project: bool = True
    bind_suite: bool = True


class GenerateAgentScoringDimensionsRequest(ApiModel):
    project_id: int
    suite_id: int | None = None
    agent_description: str
    user_requirement: str | None = None
    dimensions: list[str] | None = None
    with_reference: bool = True
    count: int = 3
    model: str | None = None
    rule_note: str | None = None


router = APIRouter()


def parse_rule_types(value: str | None) -> list[str] | None:
    if value is None:
        return None
    parsed = [item.strip() for item in value.split(",") if item.strip()]
    return parsed or None


@router.post("/api/rules")
def create_rule(payload: CreateRuleRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().create_rule(payload.model_dump(exclude_none=True))
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/rules")
def list_rules(
    request: Request,
    rule_type: str | None = Query(default=None, alias="ruleType"),
):
    request_id = request_id_from_request(request)
    data = RuleService().list_rules(rule_type=rule_type)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.get("/api/rules/overview")
def list_rule_overview(
    request: Request,
    rule_types: str | None = Query(default=None, alias="ruleTypes"),
):
    request_id = request_id_from_request(request)
    parsed_rule_types = parse_rule_types(rule_types)
    data = RuleService().list_rule_overview(rule_types=parsed_rule_types)
    return build_success_response({"items": data, "total": len(data)}, request_id=request_id)


@router.post("/api/rules/generate-agent-scoring")
def generate_agent_scoring_rules(payload: GenerateAgentScoringRulesRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().generate_agent_scoring_rules(payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.post("/api/rules/generate-agent-dimensions")
def generate_agent_scoring_dimensions(payload: GenerateAgentScoringDimensionsRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().generate_agent_scoring_dimensions(payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.get("/api/rules/{rule_id}")
def get_rule(rule_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().get_rule(rule_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.put("/api/rules/{rule_id}")
def update_rule(rule_id: int, payload: UpdateRuleRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().update_rule(rule_id, payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().delete_rule(rule_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.get("/api/rules/{rule_id}/relations")
def get_rule_relations(rule_id: int, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().get_rule_relations(rule_id)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response(data, request_id=request_id)


@router.post("/api/rules/{rule_id}/bind-projects")
def bind_projects(rule_id: int, payload: BindProjectsRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().bind_projects(rule_id, payload.project_ids)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response({"ruleId": rule_id, "projectIds": data["project_ids"]}, request_id=request_id)


@router.post("/api/rules/{rule_id}/bind-suites")
def bind_suites(rule_id: int, payload: BindSuitesRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = RuleService().bind_suites(rule_id, payload.suite_ids)
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    return build_success_response({"ruleId": rule_id, "suiteIds": data["suite_ids"]}, request_id=request_id)
