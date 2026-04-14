from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.project_api import ApiModel, NotFoundError, build_error_response, build_success_response, request_id_from_request
from app.application.api_case_generation_service import ApiCaseGenerationService


class GenerateApiCasesRequest(ApiModel):
    project_id: int
    suite_id: int
    prd_doc_asset_id: int
    api_doc_asset_id: int | None = None
    count: int = 5
    coverage: str = "mixed"
    feature_desc: str | None = None
    model: str | None = "kimi-k2.5"


class GenerateAgentDatasetRequest(ApiModel):
    project_id: int
    suite_id: int
    source_doc_asset_id: int
    api_doc_asset_id: int | None = None
    count: int = 10
    with_reference: bool = True
    dimensions: list[str] | None = None
    model: str | None = "kimi-k2.5"


class GenerateApiCasesFromBenchmarkDatasetRequest(ApiModel):
    project_id: int
    suite_id: int
    dataset_id: int
    api_doc_asset_id: int
    model: str | None = "kimi-k2.5"


router = APIRouter()


@router.post("/api/case-generation/generate")
def generate_api_cases(payload: GenerateApiCasesRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ApiCaseGenerationService().generate_api_cases(payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.post("/api/case-generation/generate-agent-dataset")
def generate_agent_dataset(payload: GenerateAgentDatasetRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ApiCaseGenerationService().generate_agent_dataset(payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)


@router.post("/api/case-generation/generate-api-from-benchmark-dataset")
def generate_api_from_benchmark_dataset(payload: GenerateApiCasesFromBenchmarkDatasetRequest, request: Request):
    request_id = request_id_from_request(request)
    try:
        data = ApiCaseGenerationService().generate_api_cases_from_benchmark_dataset(payload.model_dump(exclude_none=True))
    except NotFoundError as exc:
        return build_error_response(status_code=404, message=str(exc), request_id=request_id, code=4041001)
    except ValueError as exc:
        return build_error_response(status_code=400, message=str(exc), request_id=request_id)
    return build_success_response(data, request_id=request_id)
