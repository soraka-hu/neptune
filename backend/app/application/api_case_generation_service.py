from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from app.application.project_service import NotFoundError
from app.domain.services.schema_registry_service import CaseSchemaRegistry
from app.infrastructure.llm.model_gateway_client import ModelGatewayClient
from app.infrastructure.repositories.case_repository import CaseRepository
from app.infrastructure.repositories.project_repository import ProjectRepository
from app.infrastructure.repositories.rule_repository import RuleRepository
from app.infrastructure.repositories.suite_repository import SuiteRepository
from app.infrastructure.repositories.table_repository import TableRepository

CASE_GEN_DEFAULT_MODEL = os.getenv("CASE_GEN_MODEL", "kimi-k2.5").strip() or "kimi-k2.5"
CASE_GEN_DEFAULT_BASE_URL = (
    os.getenv("CASE_GEN_BASE_URL", "https://codingplan.alayanew.com/v1").strip()
    or "https://codingplan.alayanew.com/v1"
)
CASE_GEN_DEFAULT_API_KEY = os.getenv("CASE_GEN_API_KEY", "").strip()


@dataclass
class ParameterSpec:
    name: str
    location: str
    required: bool
    schema: dict[str, Any]
    example: Any


@dataclass
class OperationContract:
    method: str
    path_template: str
    summary: str
    description: str
    query_params: list[ParameterSpec]
    path_params: list[ParameterSpec]
    header_params: list[ParameterSpec]
    body_required: bool
    body_schema: dict[str, Any] | None
    body_required_fields: list[str]
    response_defaults: dict[int, dict[str, Any]]


class ApiCaseGenerationService:
    def __init__(
        self,
        *,
        project_repository: ProjectRepository | None = None,
        suite_repository: SuiteRepository | None = None,
        user_asset_repository: TableRepository | None = None,
        case_repository: CaseRepository | None = None,
        dataset_repository: TableRepository | None = None,
        dataset_item_repository: TableRepository | None = None,
        environment_repository: TableRepository | None = None,
        rule_repository: RuleRepository | None = None,
        model_gateway_client: ModelGatewayClient | None = None,
    ) -> None:
        self.project_repository = project_repository or ProjectRepository()
        self.suite_repository = suite_repository or SuiteRepository()
        self.user_asset_repository = user_asset_repository or TableRepository("user_asset")
        self.case_repository = case_repository or CaseRepository()
        self.dataset_repository = dataset_repository or TableRepository("dataset")
        self.dataset_item_repository = dataset_item_repository or TableRepository("dataset_item")
        self.environment_repository = environment_repository or TableRepository("environment")
        self.rule_repository = rule_repository or RuleRepository()
        self.model_gateway_client = model_gateway_client or ModelGatewayClient()

    def generate_api_cases(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = self._must_int(payload.get("project_id"), "project_id")
        suite_id = self._must_int(payload.get("suite_id"), "suite_id")
        prd_doc_asset_id = self._must_int(payload.get("prd_doc_asset_id"), "prd_doc_asset_id")
        api_doc_asset_id = self._optional_positive_int(payload.get("api_doc_asset_id"))
        count = max(1, min(50, int(payload.get("count") or 5)))
        coverage = self._normalize_coverage(payload.get("coverage"))
        feature_desc = str(payload.get("feature_desc") or "").strip()
        model_name = str(payload.get("model") or CASE_GEN_DEFAULT_MODEL).strip() or CASE_GEN_DEFAULT_MODEL

        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")
        suite = self.suite_repository.get(suite_id)
        if suite is None:
            raise NotFoundError(f"suite {suite_id} not found")
        if int(suite.get("project_id") or 0) != project_id:
            raise ValueError("suite does not belong to project")

        prd_doc = self.user_asset_repository.get(prd_doc_asset_id)
        if prd_doc is None or prd_doc.get("status") in {"archived", "deleted"}:
            raise NotFoundError(f"prd doc asset {prd_doc_asset_id} not found")
        prd_text = self._extract_text(prd_doc)
        using_api_doc = api_doc_asset_id is not None
        contracts: list[OperationContract]
        if api_doc_asset_id is not None:
            api_doc = self.user_asset_repository.get(api_doc_asset_id)
            if api_doc is None or api_doc.get("status") in {"archived", "deleted"}:
                raise NotFoundError(f"api doc asset {api_doc_asset_id} not found")
            openapi_doc = self._load_openapi_document(api_doc)
            contracts = self._build_operation_contracts(openapi_doc)
        else:
            contracts = [
                self._build_default_operation_contract(
                    prd_text=prd_text,
                    feature_desc=feature_desc,
                )
            ]

        contract_case_counts = self._split_count_across_operations(total_count=count, operation_count=len(contracts))
        operation_runs: list[dict[str, Any]] = []
        normalized_case_bundles: list[dict[str, Any]] = []
        environment_headers = self._resolve_environment_headers(project_id=project_id)
        feature_hint = feature_desc or str(prd_doc.get("name") or "接口能力")
        for contract, contract_count in zip(contracts, contract_case_counts):
            if contract_count <= 0:
                continue

            generated, generation_meta = self._generate_case_templates(
                project_id=project_id,
                count=contract_count,
                coverage=coverage,
                feature_desc=feature_desc,
                model_name=model_name,
                contract=contract,
                prd_text=prd_text,
                has_api_doc=using_api_doc,
            )
            normalized_cases = self._normalize_generated_cases(
                templates=generated,
                count=contract_count,
                coverage=coverage,
                contract=contract,
                feature_hint=feature_hint,
                environment_headers=environment_headers,
                description_source="API 文档" if using_api_doc else "PRD 文档",
            )
            operation_runs.append(
                {
                    "method": contract.method,
                    "path": contract.path_template,
                    "requested_count": contract_count,
                    "generated_count": len(normalized_cases),
                    "generation": generation_meta,
                }
            )
            for case in normalized_cases:
                normalized_case_bundles.append(
                    {
                        "contract": contract,
                        "case": case,
                        "generation": generation_meta,
                    }
                )

        generation_meta = self._safe_record(operation_runs[0].get("generation")) if operation_runs else {}
        operations_summary = [
            {
                "method": str(run.get("method") or ""),
                "path": str(run.get("path") or ""),
                "requested_count": int(run.get("requested_count") or 0),
                "generated_count": int(run.get("generated_count") or 0),
                "mode": self._safe_record(run.get("generation")).get("mode"),
                "model": self._safe_record(run.get("generation")).get("model"),
                "llm_error": self._safe_record(run.get("generation")).get("llm_error"),
            }
            for run in operation_runs
        ]

        batch_id = self._random_batch_id()
        created_cases: list[dict[str, Any]] = []
        for idx, bundle in enumerate(normalized_case_bundles, start=1):
            contract = bundle["contract"]
            case = self._safe_record(bundle.get("case"))
            case_generation_meta = self._safe_record(bundle.get("generation"))
            input_payload = {
                "schema_version": "1.0",
                "method": contract.method,
                "path": case["path"],
                "headers": case["headers"],
                "query": case["query"],
                "body": case["body"],
            }
            expected_output = {
                "schema_version": "1.0",
                "status_code": case["status_code"],
                "json_fields": case["json_fields"],
            }
            assertion_config = {
                "strategy": "json_fields",
                "checks": case["assertions"],
            }
            meta_info = {
                "generation_batch_id": batch_id,
                "generation_index": idx,
                "generation_model": case_generation_meta.get("model") or model_name,
                "generation_mode": case_generation_meta.get("mode") or "llm",
                "generation_reason": case["scenario_type"],
                "scenario_type": case["scenario_type"],
                "coverage": coverage,
                "prd_doc_id": prd_doc_asset_id,
                "api_doc_id": api_doc_asset_id,
                "operation": {"method": contract.method, "path": contract.path_template},
            }

            CaseSchemaRegistry.validate_input_payload("api", input_payload)
            CaseSchemaRegistry.validate_expected_output("api", expected_output)
            created = self.case_repository.create(
                {
                    "project_id": project_id,
                    "suite_id": suite_id,
                    "name": case["name"],
                    "description": case["description"],
                    "case_type": "api",
                    "source_type": "llm_generated",
                    "status": "draft",
                    "priority": "P2",
                    "version": 1,
                    "input_payload": input_payload,
                    "expected_output": expected_output,
                    "assertion_config": assertion_config,
                    "meta_info": meta_info,
                }
            )
            created_cases.append(created)

        history_asset = self.user_asset_repository.create(
            {
                "project_id": project_id,
                "suite_id": suite_id,
                "asset_type": "api_case_generation_batch",
                "name": f"API 生成批次 {batch_id}",
                "content_json": {
                    "batch_id": batch_id,
                    "project_id": project_id,
                    "suite_id": suite_id,
                    "prd_doc_id": prd_doc_asset_id,
                    "api_doc_id": api_doc_asset_id,
                    "generated_count": len(created_cases),
                    "coverage": coverage,
                    "feature_desc": feature_desc,
                    "model": generation_meta.get("model") or model_name,
                    "mode": generation_meta.get("mode") or "llm",
                    "llm_error": generation_meta.get("llm_error"),
                    "operation_count": len(contracts),
                    "covered_operation_count": len(operations_summary),
                    "operations": operations_summary,
                    "created_case_ids": [int(item["id"]) for item in created_cases],
                    "status": "success",
                },
                "meta_info": {
                    "suite_id": suite_id,
                    "generated_count": len(created_cases),
                    "created_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                "status": "active",
            }
        )

        return {
            "batch_id": batch_id,
            "batch_asset_id": history_asset.get("id"),
            "generated_count": len(created_cases),
            "case_ids": [int(item["id"]) for item in created_cases],
            "cases": created_cases,
            "generation": {
                "mode": generation_meta.get("mode") or "llm",
                "model": generation_meta.get("model") or model_name,
                "llm_error": generation_meta.get("llm_error"),
                "runs": operations_summary,
            },
            "operation": {
                "method": operations_summary[0]["method"],
                "path": operations_summary[0]["path"],
            },
            "operations": operations_summary,
        }

    def generate_agent_dataset(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = self._must_int(payload.get("project_id"), "project_id")
        suite_id = self._must_int(payload.get("suite_id"), "suite_id")
        source_doc_asset_id = self._must_int(payload.get("source_doc_asset_id"), "source_doc_asset_id")
        api_doc_asset_id = self._optional_positive_int(payload.get("api_doc_asset_id"))
        count = max(1, min(100, int(payload.get("count") or 10)))
        with_reference = bool(payload.get("with_reference", True))
        dimensions = self._normalize_agent_dimensions(payload.get("dimensions"))
        model_name = str(payload.get("model") or CASE_GEN_DEFAULT_MODEL).strip() or CASE_GEN_DEFAULT_MODEL

        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")
        suite = self.suite_repository.get(suite_id)
        if suite is None:
            raise NotFoundError(f"suite {suite_id} not found")
        if int(suite.get("project_id") or 0) != project_id:
            raise ValueError("suite does not belong to project")

        source_doc = self.user_asset_repository.get(source_doc_asset_id)
        if source_doc is None or source_doc.get("status") in {"archived", "deleted"}:
            raise NotFoundError(f"source doc asset {source_doc_asset_id} not found")

        api_doc: dict[str, Any] | None = None
        api_contract: OperationContract | None = None
        if api_doc_asset_id is not None:
            api_doc = self.user_asset_repository.get(api_doc_asset_id)
            if api_doc is None or api_doc.get("status") in {"archived", "deleted"}:
                raise NotFoundError(f"api doc asset {api_doc_asset_id} not found")
            api_contract = self._build_operation_contract(self._load_openapi_document(api_doc))

        source_text = self._extract_text(source_doc) or str(source_doc.get("name") or "")
        if not source_text.strip():
            raise ValueError("source doc content is empty")
        source_name = str(source_doc.get("name") or "Agent 信息文档")

        batch_id = self._random_agent_batch_id()
        suite_name = str(suite.get("name") or f"suite-{suite_id}")
        dataset = self.dataset_repository.create(
            {
                "project_id": project_id,
                "name": f"{suite_name}-agent-dataset-{batch_id[-4:]}",
                "description": "生成 Agent 数据集模块自动生成",
                "dataset_type": "with_reference" if with_reference else "without_reference",
                "status": "draft",
                "version": 1,
                "generation_config": {
                    "batch_id": batch_id,
                    "source_doc_id": source_doc_asset_id,
                    "api_doc_id": api_doc_asset_id,
                    "dimensions": dimensions,
                    "model": model_name,
                },
            }
        )

        sample_templates, generation_meta = self._generate_agent_sample_templates(
            project_id=project_id,
            source_text=source_text,
            source_name=source_name,
            count=count,
            dimensions=dimensions,
            with_reference=with_reference,
            model_name=model_name,
        )

        created_cases: list[dict[str, Any]] = []
        created_dataset_items: list[dict[str, Any]] = []
        normalized_samples: list[dict[str, Any]] = []
        seen_user_inputs: set[str] = set()
        for index, template in enumerate(sample_templates, start=1):
            scenario_type = self._normalize_agent_scenario(template.get("scenario_type"))
            user_input = self._normalize_agent_user_input(
                raw_user_input=template.get("user_input"),
                scenario_type=scenario_type,
                source_name=source_name,
                source_text=source_text,
                index=index,
            )
            # 保证每条 Benchmark 输入不同；LLM 可能会输出重复的 user_input，这里做兜底处理。
            normalized_key = re.sub(r"\s+", " ", user_input).strip()
            if normalized_key in seen_user_inputs:
                retry_input = self._normalize_agent_user_input(
                    raw_user_input=None,
                    scenario_type=scenario_type,
                    source_name=source_name,
                    source_text=source_text,
                    index=index + len(seen_user_inputs) + 1,
                )
                retry_key = re.sub(r"\s+", " ", retry_input).strip()
                if retry_key and retry_key not in seen_user_inputs:
                    user_input = retry_input
                    normalized_key = retry_key
                else:
                    # 最后兜底：确保不完全相同（即使语义不理想也避免重复）
                    user_input = f"{user_input}（补充：请用不同方式说明）"
                    normalized_key = re.sub(r"\s+", " ", user_input).strip()
            seen_user_inputs.add(normalized_key)
            conversation_history = template.get("conversation_history")
            if not isinstance(conversation_history, list):
                conversation_history = []
            tools_context = template.get("tools_context")
            if not isinstance(tools_context, list):
                tools_context = []
            constraints = self._safe_record(template.get("constraints"))
            constraints.setdefault("dimensions", dimensions)

            input_payload = {
                "schema_version": "1.0",
                "user_input": user_input,
                "conversation_history": conversation_history,
                "tools_context": tools_context,
                "constraints": constraints,
            }
            CaseSchemaRegistry.validate_input_payload("agent", input_payload)

            expected_output: dict[str, Any] | None = None
            reference_answer = self._safe_record(template.get("reference_answer"))
            if with_reference:
                if not reference_answer:
                    reference_answer = {"answer": str(template.get("reference_text") or f"样本 {index} 参考答案")}
                expected_output = {
                    "schema_version": "1.0",
                    "reference_answer": reference_answer,
                }
                CaseSchemaRegistry.validate_expected_output("reference", expected_output)

            eval_config = {
                "schema_version": "1.0",
                "evaluation_mode": "with_reference" if with_reference else "without_reference",
                "evaluators": [
                    {"type": "json_match" if with_reference else "llm_judge", "weight": 1.0},
                ],
                "threshold": 0.8,
            }
            CaseSchemaRegistry.validate_eval_config(eval_config)

            case_name = self._normalize_agent_case_name(
                raw_name=template.get("name"),
                scenario_type=scenario_type,
                index=index,
                source_name=suite_name,
            )
            case_description = str(template.get("description") or "").strip() or f"{case_name}（按 Agent 文档自动生成）"

            created_case = self.case_repository.create(
                {
                    "project_id": project_id,
                    "suite_id": suite_id,
                    "name": case_name,
                    "description": case_description,
                    "case_type": "agent",
                    "source_type": "llm_generated",
                    "status": "draft",
                    "priority": "P2",
                    "version": 1,
                    "input_payload": input_payload,
                    "expected_output": expected_output,
                    "eval_config": eval_config,
                    "meta_info": {
                        "generation_batch_id": batch_id,
                        "generation_index": index,
                        "generation_model": generation_meta.get("model") or model_name,
                        "generation_mode": generation_meta.get("mode") or "llm",
                        "scenario_type": scenario_type,
                        "dimensions": dimensions,
                        "source_doc_id": source_doc_asset_id,
                        "dataset_id": dataset.get("id"),
                    },
                }
            )
            created_cases.append(created_case)
            normalized_samples.append(
                {
                    "agent_case_id": created_case.get("id"),
                    "case_name": case_name,
                    "scenario_type": scenario_type,
                    "user_input": user_input,
                }
            )

            dataset_item = self.dataset_item_repository.create(
                {
                    "dataset_id": dataset.get("id"),
                    "case_id": created_case.get("id"),
                    "input_data": {
                        "user_input": user_input,
                        "conversation_history": conversation_history,
                        "tools_context": tools_context,
                        "constraints": constraints,
                    },
                    "reference_answer": reference_answer if with_reference else None,
                    "meta_info": {
                        "generation_batch_id": batch_id,
                        "generation_index": index,
                        "scenario_type": scenario_type,
                        "dimensions": dimensions,
                        "source_doc_id": source_doc_asset_id,
                    },
                    "status": "active",
                }
            )
            created_dataset_items.append(dataset_item)

        created_api_cases: list[dict[str, Any]] = []
        if api_contract is not None and api_doc_asset_id is not None:
            created_api_cases = self._create_api_cases_from_agent_samples(
                project_id=project_id,
                suite_id=suite_id,
                dataset_id=int(dataset.get("id")),
                batch_id=batch_id,
                source_doc_asset_id=source_doc_asset_id,
                api_doc_asset_id=api_doc_asset_id,
                model_name=model_name,
                generation_meta=generation_meta,
                contract=api_contract,
                environment_headers=self._resolve_environment_headers(project_id=project_id),
                samples=normalized_samples,
            )

        history_asset = self.user_asset_repository.create(
            {
                "project_id": project_id,
                "suite_id": suite_id,
                "asset_type": "agent_dataset_generation_batch",
                "name": f"Agent 数据集批次 {batch_id}",
                "content_json": {
                    "batch_id": batch_id,
                    "project_id": project_id,
                    "suite_id": suite_id,
                    "source_doc_id": source_doc_asset_id,
                    "api_doc_id": api_doc_asset_id,
                    "dataset_id": dataset.get("id"),
                    "generated_count": len(created_cases),
                    "generated_api_case_count": len(created_api_cases),
                    "with_reference": with_reference,
                    "dimensions": dimensions,
                    "generated_rule_ids": [],
                    "generated_api_case_ids": [int(item["id"]) for item in created_api_cases],
                    "status": "success",
                    "model": generation_meta.get("model") or model_name,
                    "mode": generation_meta.get("mode") or "llm",
                },
                "meta_info": {
                    "suite_id": suite_id,
                    "generated_count": len(created_cases),
                    "generated_api_case_count": len(created_api_cases),
                    "with_reference": with_reference,
                    "generated_rule_count": 0,
                    "created_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                "status": "active",
            }
        )

        return {
            "batch_id": batch_id,
            "batch_asset_id": history_asset.get("id"),
            "dataset_id": dataset.get("id"),
            "generated_count": len(created_cases),
            "case_ids": [int(item["id"]) for item in created_cases],
            "api_case_ids": [int(item["id"]) for item in created_api_cases],
            "api_generated_count": len(created_api_cases),
            "dataset_item_ids": [int(item["id"]) for item in created_dataset_items],
            "generated_rule_ids": [],
            "generation": generation_meta,
            "rule_generation": None,
        }

    def generate_api_cases_from_benchmark_dataset(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = self._must_int(payload.get("project_id"), "project_id")
        suite_id = self._must_int(payload.get("suite_id"), "suite_id")
        dataset_id = self._must_int(payload.get("dataset_id"), "dataset_id")
        api_doc_asset_id = self._must_int(payload.get("api_doc_asset_id"), "api_doc_asset_id")
        model_name = str(payload.get("model") or CASE_GEN_DEFAULT_MODEL).strip() or CASE_GEN_DEFAULT_MODEL

        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")
        suite = self.suite_repository.get(suite_id)
        if suite is None:
            raise NotFoundError(f"suite {suite_id} not found")
        if int(suite.get("project_id") or 0) != project_id:
            raise ValueError("suite does not belong to project")

        dataset = self.dataset_repository.get(dataset_id)
        if dataset is None:
            raise NotFoundError(f"dataset {dataset_id} not found")
        if int(dataset.get("project_id") or 0) != project_id:
            raise ValueError("dataset does not belong to project")

        api_doc = self.user_asset_repository.get(api_doc_asset_id)
        if api_doc is None or api_doc.get("status") in {"archived", "deleted"}:
            raise NotFoundError(f"api doc asset {api_doc_asset_id} not found")
        contract = self._build_operation_contract(self._load_openapi_document(api_doc))

        dataset_items = self.dataset_item_repository.list({"dataset_id": dataset_id})
        active_items = [
            item
            for item in dataset_items
            if str(item.get("status") or "active").strip().lower() not in {"archived", "deleted"}
        ]
        if not active_items:
            raise ValueError("dataset has no active items")

        sorted_items = sorted(active_items, key=lambda item: int(item.get("id") or 0))
        samples: list[dict[str, Any]] = []
        for index, dataset_item in enumerate(sorted_items, start=1):
            input_data = self._safe_record(dataset_item.get("input_data"))
            user_input = str(input_data.get("user_input") or "").strip()
            if not user_input:
                raise ValueError(f"dataset item {dataset_item.get('id')} missing input_data.user_input")

            meta_info = self._safe_record(dataset_item.get("meta_info"))
            scenario_type = self._normalize_agent_scenario(meta_info.get("scenario_type"))
            raw_case_name = str(meta_info.get("case_name") or "").strip() or f"Benchmark映射API案例{index}"
            samples.append(
                {
                    "agent_case_id": dataset_item.get("case_id"),
                    "dataset_item_id": dataset_item.get("id"),
                    "case_name": raw_case_name,
                    "scenario_type": scenario_type,
                    "user_input": user_input,
                }
            )

        generation_config = self._safe_record(dataset.get("generation_config"))
        source_doc_asset_id = self._optional_positive_int(generation_config.get("source_doc_id"), field_name="source_doc_id")
        generation_meta = {"model": model_name, "mode": "dataset_input_mapping"}
        batch_id = self._random_batch_id()
        created_api_cases = self._create_api_cases_from_agent_samples(
            project_id=project_id,
            suite_id=suite_id,
            dataset_id=dataset_id,
            batch_id=batch_id,
            source_doc_asset_id=source_doc_asset_id,
            api_doc_asset_id=api_doc_asset_id,
            model_name=model_name,
            generation_meta=generation_meta,
            contract=contract,
            environment_headers=self._resolve_environment_headers(project_id=project_id),
            samples=samples,
        )

        history_asset = self.user_asset_repository.create(
            {
                "project_id": project_id,
                "suite_id": suite_id,
                "asset_type": "api_case_generation_batch",
                "name": f"API 生成批次 {batch_id}",
                "content_json": {
                    "batch_id": batch_id,
                    "project_id": project_id,
                    "suite_id": suite_id,
                    "prd_doc_id": source_doc_asset_id,
                    "api_doc_id": api_doc_asset_id,
                    "dataset_id": dataset_id,
                    "generated_count": len(created_api_cases),
                    "source_item_count": len(samples),
                    "source_type": "benchmark_dataset",
                    "model": generation_meta.get("model") or model_name,
                    "mode": generation_meta.get("mode") or "dataset_input_mapping",
                    "created_case_ids": [int(item["id"]) for item in created_api_cases],
                    "status": "success",
                },
                "meta_info": {
                    "suite_id": suite_id,
                    "generated_count": len(created_api_cases),
                    "source_item_count": len(samples),
                    "created_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                "status": "active",
            }
        )

        return {
            "batch_id": batch_id,
            "batch_asset_id": history_asset.get("id"),
            "dataset_id": dataset_id,
            "source_item_count": len(samples),
            "generated_count": len(created_api_cases),
            "case_ids": [int(item["id"]) for item in created_api_cases],
            "cases": created_api_cases,
            "operation": {"method": contract.method, "path": contract.path_template},
        }

    def _build_operation_contract(self, openapi_doc: dict[str, Any]) -> OperationContract:
        contracts = self._build_operation_contracts(openapi_doc)
        return contracts[0]

    def _build_operation_contracts(self, openapi_doc: dict[str, Any]) -> list[OperationContract]:
        root = openapi_doc
        paths = self._safe_record(root.get("paths"))
        if not paths:
            raise ValueError("API 文档缺少 paths，无法生成案例")

        contracts: list[OperationContract] = []
        for candidate_path, path_value in paths.items():
            path_dict = self._safe_record(path_value)
            for candidate_method in ("post", "get", "put", "patch", "delete"):
                op = self._safe_record(path_dict.get(candidate_method))
                if op:
                    contracts.append(
                        self._build_operation_contract_from_node(
                            root=root,
                            path_template=str(candidate_path),
                            method=candidate_method.upper(),
                            path_level=path_dict,
                            operation=op,
                        )
                    )
        if not contracts:
            raise ValueError("API 文档中未找到可用接口定义")
        return contracts

    def _build_operation_contract_from_node(
        self,
        *,
        root: dict[str, Any],
        path_template: str,
        method: str,
        path_level: dict[str, Any],
        operation: dict[str, Any],
    ) -> OperationContract:
        path_template = self._apply_server_base_path(openapi_doc=root, path_template=path_template)

        all_parameters = []
        for raw in self._safe_list(path_level.get("parameters")) + self._safe_list(operation.get("parameters")):
            param = self._resolve_reference(root, raw)
            if isinstance(param, dict):
                all_parameters.append(param)

        query_params: list[ParameterSpec] = []
        path_params: list[ParameterSpec] = []
        header_params: list[ParameterSpec] = []
        for item in all_parameters:
            name = str(item.get("name") or "").strip()
            location = str(item.get("in") or "").strip()
            if not name or location not in {"query", "path", "header"}:
                continue
            schema = self._resolve_schema(root, self._safe_record(item.get("schema")))
            parameter = ParameterSpec(
                name=name,
                location=location,
                required=bool(item.get("required")),
                schema=schema,
                example=item.get("example", schema.get("example")),
            )
            if location == "query":
                query_params.append(parameter)
            elif location == "path":
                path_params.append(parameter)
            else:
                header_params.append(parameter)

        request_body = self._resolve_reference(root, operation.get("requestBody"))
        request_body_record = self._safe_record(request_body)
        body_required = bool(request_body_record.get("required"))
        body_schema: dict[str, Any] | None = None
        body_required_fields: list[str] = []
        content = self._safe_record(request_body_record.get("content"))
        body_payload = self._safe_record(content.get("application/json"))
        if not body_payload and content:
            body_payload = self._safe_record(next(iter(content.values())))
        if body_payload:
            body_schema = self._resolve_schema(root, self._safe_record(body_payload.get("schema")))
            body_required_fields = [str(item) for item in self._safe_list(body_schema.get("required")) if isinstance(item, str)]

        response_defaults = self._extract_response_defaults(root, operation)
        summary = str(operation.get("summary") or "").strip()
        description = str(operation.get("description") or "").strip()
        return OperationContract(
            method=method,
            path_template=path_template,
            summary=summary,
            description=description,
            query_params=query_params,
            path_params=path_params,
            header_params=header_params,
            body_required=body_required,
            body_schema=body_schema,
            body_required_fields=body_required_fields,
            response_defaults=response_defaults,
        )

    def _split_count_across_operations(self, *, total_count: int, operation_count: int) -> list[int]:
        if operation_count <= 0:
            return []
        if total_count <= 0:
            return [0] * operation_count
        base = total_count // operation_count
        remainder = total_count % operation_count
        return [base + (1 if index < remainder else 0) for index in range(operation_count)]

    def _build_default_operation_contract(self, *, prd_text: str, feature_desc: str) -> OperationContract:
        topic_hint = feature_desc.strip()
        if not topic_hint:
            first_line = re.split(r"[\n。！？!?]", str(prd_text or "").strip(), maxsplit=1)[0].strip()
            topic_hint = first_line
        topic_hint = topic_hint or "根据 PRD 生成的接口"
        topic_hint = topic_hint[:80]
        message_example = topic_hint[:120]

        return OperationContract(
            method="POST",
            path_template="/api/auto-generated",
            summary=topic_hint,
            description="未选择 API 文档，已根据 PRD 文档生成默认接口 contract。",
            query_params=[],
            path_params=[],
            header_params=[],
            body_required=True,
            body_schema={
                "type": "object",
                "required": ["message"],
                "properties": {
                    "message": {"type": "string", "example": message_example},
                },
            },
            body_required_fields=["message"],
            response_defaults={200: {"code": 0, "message": "success"}},
        )

    def _create_api_cases_from_agent_samples(
        self,
        *,
        project_id: int,
        suite_id: int,
        dataset_id: int,
        batch_id: str,
        source_doc_asset_id: int | None,
        api_doc_asset_id: int,
        model_name: str,
        generation_meta: dict[str, Any],
        contract: OperationContract,
        environment_headers: dict[str, str],
        samples: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        created_cases: list[dict[str, Any]] = []
        success_json_fields = self._safe_record(contract.response_defaults.get(200))
        if not success_json_fields:
            success_json_fields = {"code": 200, "message": "success"}

        for index, sample in enumerate(samples, start=1):
            scenario_type = self._normalize_agent_scenario(sample.get("scenario_type"))
            user_input = str(sample.get("user_input") or "").strip()
            if not user_input:
                user_input = self._normalize_agent_user_input(
                    raw_user_input=None,
                    scenario_type=scenario_type,
                    source_name="智能体",
                    source_text="",
                    index=index,
                )

            path_params = {
                item.name: str(self._sample_by_schema(item.name, item.schema, item.example))
                for item in contract.path_params
            }
            path = self._resolve_path(contract.path_template, path_params)

            query: dict[str, Any] = {}
            for param in contract.query_params:
                if param.required:
                    query[param.name] = self._sample_by_schema(param.name, param.schema, param.example)

            headers: dict[str, str] = {}
            if contract.body_schema is not None:
                headers["Content-Type"] = "application/json"
            headers.update(environment_headers)
            for param in contract.header_params:
                current = headers.get(param.name)
                if current in {None, ""} and param.required:
                    headers[param.name] = str(self._sample_by_schema(param.name, param.schema, param.example))

            body: Any = self._default_body(contract.body_schema, include_required_only=False)
            query, body = self._bind_agent_input_to_api_payload(
                contract=contract,
                user_input=user_input,
                query=query,
                body=body,
            )
            body = self._normalize_nullable_thread_id(body=body, schema=contract.body_schema)

            raw_case_name = str(sample.get("case_name") or "").strip()
            case_name = self._normalize_case_name(
                raw_name=raw_case_name if raw_case_name else None,
                feature_hint="智能体输入映射",
                scenario_type="normal",
                status_code=200,
                index=index,
            )
            case_description = f"由 Agent Benchmark 输入映射生成的 API 案例：{user_input[:80]}"

            linked_agent_case_id: int | None = None
            try:
                linked_agent_case_id = int(sample.get("agent_case_id"))  # type: ignore[arg-type]
            except (TypeError, ValueError):
                linked_agent_case_id = None

            input_payload = {
                "schema_version": "1.0",
                "method": contract.method,
                "path": path,
                "headers": headers,
                "query": query,
                "body": body,
            }
            expected_output = {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": success_json_fields,
            }
            assertion_config = {
                "strategy": "json_fields",
                "checks": [
                    {"path": f"$.{key}", "op": "eq", "value": value}
                    for key, value in success_json_fields.items()
                ],
            }

            CaseSchemaRegistry.validate_input_payload("api", input_payload)
            CaseSchemaRegistry.validate_expected_output("api", expected_output)

            meta_info = {
                "generation_batch_id": batch_id,
                "generation_index": index,
                "generation_model": generation_meta.get("model") or model_name,
                "generation_mode": generation_meta.get("mode") or "llm",
                "generation_reason": "agent_input_to_api_case",
                "scenario_type": scenario_type,
                "api_doc_id": api_doc_asset_id,
                "dataset_id": dataset_id,
                "linked_agent_case_id": linked_agent_case_id,
                "linked_dataset_item_id": sample.get("dataset_item_id"),
                "linked_agent_user_input": user_input,
            }
            if source_doc_asset_id is not None:
                meta_info["source_doc_id"] = source_doc_asset_id

            created = self.case_repository.create(
                {
                    "project_id": project_id,
                    "suite_id": suite_id,
                    "name": case_name,
                    "description": case_description,
                    "case_type": "api",
                    "source_type": "llm_generated",
                    "status": "draft",
                    "priority": "P2",
                    "version": 1,
                    "input_payload": input_payload,
                    "expected_output": expected_output,
                    "assertion_config": assertion_config,
                    "meta_info": meta_info,
                }
            )
            created_cases.append(created)

        return created_cases

    def _bind_agent_input_to_api_payload(
        self,
        *,
        contract: OperationContract,
        user_input: str,
        query: dict[str, Any],
        body: Any,
    ) -> tuple[dict[str, Any], Any]:
        normalized_input = str(user_input or "").strip()
        if not normalized_input:
            return query, body

        candidate_names = {
            "message",
            "input",
            "query",
            "question",
            "prompt",
            "text",
            "content",
            "user_input",
            "utterance",
        }

        body_schema = contract.body_schema if isinstance(contract.body_schema, dict) else None
        body_properties = self._safe_record(body_schema.get("properties") if body_schema else None)

        if isinstance(body, dict):
            for key in body_properties.keys():
                if key.lower() in candidate_names:
                    body[key] = normalized_input
                    return query, body

            for key in list(body.keys()):
                if key.lower() in candidate_names:
                    body[key] = normalized_input
                    return query, body

            required_fields = [
                str(item)
                for item in self._safe_list(body_schema.get("required") if body_schema else None)
                if isinstance(item, str)
            ]
            for field in required_fields:
                field_schema = self._safe_record(body_properties.get(field))
                if field_schema.get("type") == "string":
                    body[field] = normalized_input
                    return query, body

            for field, raw_schema in body_properties.items():
                field_schema = self._safe_record(raw_schema)
                if field_schema.get("type") == "string":
                    body[field] = normalized_input
                    return query, body

            if body_schema is not None and not body_properties:
                body["message"] = normalized_input
                return query, body

        for parameter in contract.query_params:
            if parameter.name.lower() in candidate_names:
                query[parameter.name] = normalized_input
                return query, body

        for parameter in contract.query_params:
            schema = self._safe_record(parameter.schema)
            if parameter.required and schema.get("type") in {"string", None}:
                query[parameter.name] = normalized_input
                return query, body

        return query, body

    def _apply_server_base_path(self, *, openapi_doc: dict[str, Any], path_template: str) -> str:
        normalized_path = path_template if path_template.startswith("/") else f"/{path_template}"
        servers = self._safe_list(openapi_doc.get("servers"))
        if not servers:
            return normalized_path

        server = self._safe_record(servers[0])
        raw_url = str(server.get("url") or "").strip()
        if not raw_url:
            return normalized_path

        parsed = urlparse(raw_url)
        server_path = parsed.path.strip() if parsed.path else ""
        if not server_path and (raw_url.startswith("/") or raw_url.startswith("./")):
            server_path = raw_url

        if not server_path or "{" in server_path or "}" in server_path:
            return normalized_path

        base_path = server_path if server_path.startswith("/") else f"/{server_path}"
        base_path = re.sub(r"/+", "/", base_path).rstrip("/")
        if not base_path:
            return normalized_path

        if normalized_path == base_path or normalized_path.startswith(f"{base_path}/"):
            return normalized_path
        return f"{base_path}{normalized_path}"

    def _extract_response_defaults(self, root: dict[str, Any], operation: dict[str, Any]) -> dict[int, dict[str, Any]]:
        response_map: dict[int, dict[str, Any]] = {}
        responses = self._safe_record(operation.get("responses"))
        for status_raw, payload in responses.items():
            try:
                status_code = int(status_raw)
            except (TypeError, ValueError):
                continue
            response_record = self._safe_record(self._resolve_reference(root, payload))
            content = self._safe_record(response_record.get("content"))
            json_content = self._safe_record(content.get("application/json"))
            if not json_content and content:
                json_content = self._safe_record(next(iter(content.values())))
            if not json_content:
                continue
            schema = self._resolve_schema(root, self._safe_record(json_content.get("schema")))
            properties = self._safe_record(schema.get("properties"))
            json_fields: dict[str, Any] = {}
            for key, raw_schema in properties.items():
                prop_schema = self._safe_record(raw_schema)
                if prop_schema.get("example") is not None:
                    json_fields[key] = prop_schema.get("example")
                elif prop_schema.get("default") is not None:
                    json_fields[key] = prop_schema.get("default")
            if json_fields:
                response_map[status_code] = json_fields
        return response_map

    def _generate_case_templates(
        self,
        *,
        project_id: int,
        count: int,
        coverage: str,
        feature_desc: str,
        model_name: str,
        contract: OperationContract,
        prd_text: str,
        has_api_doc: bool,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        prompt = self._build_generation_prompt(contract, count, coverage, has_api_doc=has_api_doc)
        user_input = {
            "count": count,
            "coverage": coverage,
            "feature_desc": feature_desc,
            "prd_summary": prd_text[:6000],
            "operation": {
                "method": contract.method,
                "path_template": contract.path_template,
                "summary": contract.summary,
                "description": contract.description,
                "path_params": [self._serialize_param(item) for item in contract.path_params],
                "query_params": [self._serialize_param(item) for item in contract.query_params],
                "header_params": [self._serialize_param(item) for item in contract.header_params],
                "body_required": contract.body_required,
                "body_required_fields": contract.body_required_fields,
                "body_schema": contract.body_schema,
                "response_defaults": contract.response_defaults,
            },
        }

        try:
            llm_config: dict[str, Any] = {
                "model": model_name,
                "base_url": CASE_GEN_DEFAULT_BASE_URL,
                "temperature": 0.2,
            }
            if CASE_GEN_DEFAULT_API_KEY:
                llm_config["api_key"] = CASE_GEN_DEFAULT_API_KEY

            llm_result = self.model_gateway_client.complete(
                project_id=project_id,
                prompt=prompt,
                user_input=user_input,
                context={"task": "api_case_generation"},
                config=llm_config,
            )
            templates = self._coerce_case_templates(llm_result.get("parsed_output"), llm_result.get("raw_output"))
            if templates:
                return templates, {"mode": "llm", "model": llm_result.get("model_name") or model_name}
            return self._build_fallback_templates(count, coverage, contract), {
                "mode": "fallback",
                "model": llm_result.get("model_name") or model_name,
                "llm_error": "llm 返回结构不合法，已回退规则生成",
            }
        except Exception as exc:  # noqa: BLE001
            return self._build_fallback_templates(count, coverage, contract), {
                "mode": "fallback",
                "model": model_name,
                "llm_error": str(exc),
            }

    def _normalize_generated_cases(
        self,
        *,
        templates: list[dict[str, Any]],
        count: int,
        coverage: str,
        contract: OperationContract,
        feature_hint: str,
        environment_headers: dict[str, str],
        description_source: str = "API 文档",
    ) -> list[dict[str, Any]]:
        fallback = self._build_fallback_templates(count, coverage, contract)
        source = templates or fallback
        if not source:
            source = [{"scenario_type": "normal"}]

        result: list[dict[str, Any]] = []
        for index in range(count):
            template = source[index % len(source)]
            if not isinstance(template, dict):
                template = {}
            scenario_type = self._normalize_scenario(template.get("scenario_type"))
            status_code = self._resolve_status_code(template, scenario_type)
            positive_case = status_code < 400

            path_params = self._normalize_path_params(template, contract, positive_case=positive_case)
            resolved_path = self._resolve_path(contract.path_template, path_params)
            query = self._normalize_query(template, contract, positive_case=positive_case)
            headers = self._normalize_headers(
                template,
                contract,
                positive_case=positive_case,
                scenario_type=scenario_type,
                environment_headers=environment_headers,
            )
            body = self._normalize_body(template, contract, positive_case=positive_case)
            json_fields = self._normalize_json_fields(template, contract, status_code)
            assertions = self._normalize_assertions(template, json_fields)

            name = self._normalize_case_name(
                raw_name=template.get("name"),
                feature_hint=feature_hint,
                scenario_type=scenario_type,
                status_code=status_code,
                index=index,
            )
            description = str(template.get("description") or "").strip()
            if not description:
                description = f"{name}（按 {description_source} 自动生成）"

            result.append(
                {
                    "name": name,
                    "description": description,
                    "scenario_type": scenario_type,
                    "path": resolved_path,
                    "headers": headers,
                    "query": query,
                    "body": body,
                    "status_code": status_code,
                    "json_fields": json_fields,
                    "assertions": assertions,
                }
            )
        return result

    def _normalize_path_params(self, template: dict[str, Any], contract: OperationContract, *, positive_case: bool) -> dict[str, str]:
        raw_map = self._safe_record(template.get("path_params"))
        result: dict[str, str] = {}
        for param in contract.path_params:
            value = raw_map.get(param.name)
            if value in {None, ""} and positive_case:
                value = self._sample_by_schema(param.name, param.schema, param.example)
            if value in {None, ""}:
                value = self._sample_by_schema(param.name, param.schema, param.example)
            result[param.name] = str(value)
        return result

    def _normalize_query(self, template: dict[str, Any], contract: OperationContract, *, positive_case: bool) -> dict[str, Any]:
        raw_query = self._safe_record(template.get("query"))
        result: dict[str, Any] = {}
        for param in contract.query_params:
            value = raw_query.get(param.name)
            if value is None and positive_case and param.required:
                value = self._sample_by_schema(param.name, param.schema, param.example)
            if value is None:
                continue
            result[param.name] = value
        return result

    def _normalize_headers(
        self,
        template: dict[str, Any],
        contract: OperationContract,
        *,
        positive_case: bool,
        scenario_type: str,
        environment_headers: dict[str, str],
    ) -> dict[str, str]:
        raw_headers = self._safe_record(template.get("headers"))
        headers: dict[str, str] = {}
        if contract.body_schema is not None:
            headers["Content-Type"] = "application/json"

        headers.update(environment_headers)

        for param in contract.header_params:
            value = headers.get(param.name)
            if value in {None, ""}:
                value = raw_headers.get(param.name)
            if value in {None, ""} and positive_case and param.required:
                value = self._sample_by_schema(param.name, param.schema, param.example)
            if value in {None, ""}:
                continue
            headers[param.name] = str(value)

        if scenario_type == "auth":
            for key in list(headers.keys()):
                if self._looks_like_auth_header(key):
                    headers.pop(key, None)
        return headers

    def _resolve_environment_headers(self, *, project_id: int) -> dict[str, str]:
        environments = self.environment_repository.list({"project_id": project_id})
        active = [item for item in environments if str(item.get("status") or "active") == "active"]
        if not active:
            return {}
        ordered = sorted(
            active,
            key=lambda item: (
                0 if str(item.get("env_type") or "") == "test" else 1,
                -int(item.get("id") or 0),
            ),
        )
        picked = ordered[0]
        raw_headers = picked.get("headers")
        if not isinstance(raw_headers, dict):
            return {}
        resolved: dict[str, str] = {}
        for key, value in raw_headers.items():
            if key is None or value is None:
                continue
            resolved[str(key)] = str(value)
        return resolved

    def _normalize_body(self, template: dict[str, Any], contract: OperationContract, *, positive_case: bool) -> Any:
        if contract.body_schema is None:
            return self._safe_record(template.get("body"))
        schema = contract.body_schema
        body_value = template.get("body")
        if not isinstance(body_value, dict):
            body_value = {}
        properties = self._safe_record(schema.get("properties"))
        allow_additional = bool(schema.get("additionalProperties"))
        normalized: dict[str, Any] = {}

        if properties:
            for key, value in body_value.items():
                if key in properties or allow_additional:
                    normalized[key] = value
            if positive_case:
                for field in contract.body_required_fields:
                    if normalized.get(field) is None:
                        normalized[field] = self._sample_by_schema(
                            field,
                            self._safe_record(properties.get(field)),
                            self._safe_record(properties.get(field)).get("example"),
                        )
        else:
            normalized = body_value
        return self._normalize_nullable_thread_id(body=normalized, schema=schema)

    def _normalize_json_fields(self, template: dict[str, Any], contract: OperationContract, status_code: int) -> dict[str, Any]:
        expected = self._safe_record(template.get("expected"))
        json_fields = self._safe_record(expected.get("json_fields"))
        if not json_fields:
            json_fields = self._safe_record(template.get("json_fields"))
        if not json_fields:
            json_fields = dict(contract.response_defaults.get(status_code, {}))
        if not json_fields:
            if status_code == 200:
                json_fields = {"code": 0, "message": "success"}
            elif status_code == 401:
                json_fields = {"code": 401, "message": "unauthorized"}
            else:
                json_fields = {"code": status_code, "message": "error"}
        return json_fields

    def _normalize_assertions(self, template: dict[str, Any], json_fields: dict[str, Any]) -> list[dict[str, Any]]:
        raw_assertions = self._safe_list(template.get("assertions"))
        checks: list[dict[str, Any]] = []
        for item in raw_assertions:
            assertion = self._safe_record(item)
            path = assertion.get("path")
            op = assertion.get("op")
            if isinstance(path, str) and isinstance(op, str):
                checks.append({"path": path, "op": op, "value": assertion.get("value")})
        if checks:
            return checks
        return [{"path": f"$.{key}", "op": "eq", "value": value} for key, value in json_fields.items()]

    def _resolve_status_code(self, template: dict[str, Any], scenario_type: str) -> int:
        expected = self._safe_record(template.get("expected"))
        raw_status = expected.get("status_code", template.get("status_code"))
        try:
            status = int(raw_status)
        except (TypeError, ValueError):
            if scenario_type == "auth":
                status = 401
            elif scenario_type in {"validation", "exception"}:
                status = 400
            else:
                status = 200
        return status if 100 <= status <= 599 else 200

    def _build_generation_prompt(
        self,
        contract: OperationContract,
        count: int,
        coverage: str,
        *,
        has_api_doc: bool,
    ) -> str:
        if not has_api_doc:
            return (
                "你是 API 测试用例生成器。请根据 PRD 文档和功能描述生成测试案例，返回 JSON。\n"
                "约束：\n"
                "1) 必须输出合法 JSON，禁止 markdown。\n"
                "2) path/query/header/body 结构必须完整；没有字段时输出空对象 {}。\n"
                "3) 路径禁止保留 {param} 占位符，需输出可执行路径。\n"
                "4) 正常场景预期状态码为 200，异常场景建议返回 4xx。\n"
                "5) 断言使用 expected.json_fields 里的关键字段。\n"
                "输出格式：\n"
                "{\n"
                '  "cases": [\n'
                "    {\n"
                '      "name": "中文案例名",\n'
                '      "description": "一句话描述",\n'
                '      "scenario_type": "normal|validation|boundary|auth|exception",\n'
                '      "path_params": {},\n'
                '      "query": {},\n'
                '      "headers": {},\n'
                '      "body": {},\n'
                '      "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},\n'
                '      "assertions": [{"path":"$.code","op":"eq","value":0}]\n'
                "    }\n"
                "  ]\n"
                "}\n"
                f"本次目标数量: {count}，覆盖策略: {coverage}。\n"
                f"默认接口: {contract.method} {contract.path_template}。"
            )

        return (
            "你是 API 测试用例生成器。请严格根据 OpenAPI 文档生成测试案例，返回 JSON。\n"
            "强约束：\n"
            "1) 只允许使用文档中定义的参数：path/query/header/requestBody。\n"
            "2) requestBody.required 字段必须被尊重：正常场景要传必填字段；异常场景可故意缺失必填字段。\n"
            "3) query 只允许文档定义字段；没有定义 query 时必须输出空对象 {}。\n"
            "4) path 参数必须给具体值，不要保留 {param} 占位符。\n"
            "5) 输出必须是合法 JSON，禁止 markdown。\n"
            "6) 若 requestBody 中存在 thread_id 且该字段可为空（nullable=true 或 type 包含 null），thread_id 必须输出 null，禁止填 thread_id_sample 等示例字符串。\n"
            "输出格式：\n"
            "{\n"
            '  "cases": [\n'
            "    {\n"
            '      "name": "中文案例名",\n'
            '      "description": "一句话描述",\n'
            '      "scenario_type": "normal|validation|boundary|auth|exception",\n'
            '      "path_params": {"id":"xxx"},\n'
            '      "query": {},\n'
            '      "headers": {},\n'
            '      "body": {},\n'
            '      "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},\n'
            '      "assertions": [{"path":"$.code","op":"eq","value":0}]\n'
            "    }\n"
            "  ]\n"
            "}\n"
            f"本次目标数量: {count}，覆盖策略: {coverage}。\n"
            f"接口: {contract.method} {contract.path_template}。"
        )

    def _coerce_case_templates(self, parsed_output: Any, raw_output: Any) -> list[dict[str, Any]]:
        if isinstance(parsed_output, list):
            return [self._safe_record(item) for item in parsed_output if isinstance(item, dict)]
        if isinstance(parsed_output, dict):
            cases = self._safe_list(parsed_output.get("cases"))
            return [self._safe_record(item) for item in cases if isinstance(item, dict)]
        if isinstance(raw_output, str):
            try:
                parsed = json.loads(raw_output)
            except json.JSONDecodeError:
                return []
            return self._coerce_case_templates(parsed, parsed)
        return []

    def _build_fallback_templates(self, count: int, coverage: str, contract: OperationContract) -> list[dict[str, Any]]:
        scenarios = self._scenario_cycle(coverage)
        templates: list[dict[str, Any]] = []
        base_path_params = {
            item.name: self._sample_by_schema(item.name, item.schema, item.example) for item in contract.path_params
        }
        base_query = {item.name: self._sample_by_schema(item.name, item.schema, item.example) for item in contract.query_params}
        base_headers = {item.name: self._sample_by_schema(item.name, item.schema, item.example) for item in contract.header_params}
        base_body = self._default_body(contract.body_schema, include_required_only=False)

        for index in range(count):
            scenario = scenarios[index % len(scenarios)]
            status_code = 200
            path_params = dict(base_path_params)
            query = dict(base_query)
            headers = dict(base_headers)
            body = dict(base_body)
            if scenario in {"validation", "exception"}:
                status_code = 400
                if contract.body_required_fields:
                    body.pop(contract.body_required_fields[0], None)
                elif contract.query_params:
                    query.pop(contract.query_params[0].name, None)
            elif scenario == "auth":
                status_code = 401
                for key in list(headers.keys()):
                    if self._looks_like_auth_header(key):
                        headers.pop(key, None)
            elif scenario == "boundary":
                status_code = 200
                numeric_field = self._first_numeric_field(contract.body_schema)
                if numeric_field:
                    body[numeric_field] = 0

            expected = contract.response_defaults.get(status_code)
            if not expected:
                expected = {"code": 0, "message": "success"} if status_code == 200 else {"code": status_code, "message": "error"}

            templates.append(
                {
                    "name": "",
                    "description": "",
                    "scenario_type": scenario,
                    "path_params": path_params,
                    "query": query,
                    "headers": headers,
                    "body": body,
                    "expected": {"status_code": status_code, "json_fields": expected},
                    "assertions": [{"path": f"$.{k}", "op": "eq", "value": v} for k, v in expected.items()],
                }
            )
        return templates

    def _generate_agent_sample_templates(
        self,
        *,
        project_id: int,
        source_text: str,
        source_name: str,
        count: int,
        dimensions: list[str],
        with_reference: bool,
        model_name: str,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        topic_hint = self._extract_agent_topic_hint(source_name=source_name, source_text=source_text)
        prompt = (
            "你是智能体 Benchmark 样本生成器。请结合下方 Agent 信息文档，用大模型推理为该智能体设计「拟人化对话」测试用例。\n"
            "核心目标：让 user_input 像真实用户在和该 Agent 聊天/倾诉/请教时会发的内容，而不是生硬的测试指令。\n"
            "必须以 Agent 信息为导向：围绕文档中的定位、能力、边界与典型场景提出话题与问题。\n"
            "约束：\n"
            "1) 只输出 JSON，禁止 markdown。\n"
            "2) 场景类型仅允许：single_turn、multi_turn、tool_calling、open_task。\n"
            "3) user_input 必须是第一人称、口语化、具备生活化情境与情绪（可含原因片段“因为……”），并自然带出请求（想聊聊/想听建议/想被安慰/想被解释清楚）。\n"
            "4) user_input 必须与 Agent 文档的角色/能力一致，避免泛聊无关主题。\n"
            "5) 禁止出现自我介绍式提问（如“你能做什么/介绍一下你自己/你的核心目标是什么”）与条目化命令（如“给我3点/输出清单”）。\n"
            "6) user_input 禁止出现“根据文档/基于文档/完成任务/样本1”等模板措辞。\n"
            "5) with_reference=true 时必须给 reference_answer 对象。\n"
            "6) 每条 samples[i].user_input 必须互不相同（禁止重复），并尽量覆盖不同意图/不同问题点。\n"
            "7) 参考风格示例（仅作语气参考，具体话题要贴合 Agent 文档）：\n"
            f"   - 我最近在{topic_hint}上特别焦虑，因为……你能陪我聊聊吗？\n"
            f"   - 我现在有点崩溃，事情跟{topic_hint}有关，你能不能先安慰我一下再给建议？\n"
            f"   - 我纠结要不要……（与{topic_hint}相关），你帮我分析一下我到底在怕什么？\n"
            f"   - 刚才你说的我没太懂，能用更简单的话解释一下{topic_hint}吗？\n"
            "输出格式：\n"
            "{\n"
            '  "samples": [\n'
            "    {\n"
            '      "name": "样本名称",\n'
            '      "description": "样本说明",\n'
            '      "scenario_type": "single_turn",\n'
            '      "user_input": "用户输入",\n'
            '      "conversation_history": [],\n'
            '      "tools_context": [],\n'
            '      "constraints": {"language":"zh","format":"text"},\n'
            '      "reference_answer": {"answer":"参考答案"}\n'
            "    }\n"
            "  ]\n"
            "}\n"
            f"本次生成数量: {count}，维度: {','.join(dimensions)}，with_reference: {with_reference}。"
        )
        user_input = {
            "source_name": source_name,
            "source_excerpt": source_text[:8000],
            "count": count,
            "dimensions": dimensions,
            "with_reference": with_reference,
        }

        try:
            llm_config: dict[str, Any] = {
                "model": model_name,
                "base_url": CASE_GEN_DEFAULT_BASE_URL,
                "temperature": 0.3,
            }
            if CASE_GEN_DEFAULT_API_KEY:
                llm_config["api_key"] = CASE_GEN_DEFAULT_API_KEY

            llm_result = self.model_gateway_client.complete(
                project_id=project_id,
                prompt=prompt,
                user_input=user_input,
                context={"task": "agent_dataset_generation"},
                config=llm_config,
            )
            templates = self._coerce_agent_sample_templates(llm_result.get("parsed_output"), llm_result.get("raw_output"))
            if templates:
                return templates, {"mode": "llm", "model": llm_result.get("model_name") or model_name}
            return self._build_agent_sample_fallbacks(
                count=count,
                dimensions=dimensions,
                with_reference=with_reference,
                source_name=source_name,
            ), {
                "mode": "fallback",
                "model": llm_result.get("model_name") or model_name,
                "llm_error": "llm 返回结构不合法，已回退规则生成",
            }
        except Exception as exc:  # noqa: BLE001
            return self._build_agent_sample_fallbacks(
                count=count,
                dimensions=dimensions,
                with_reference=with_reference,
                source_name=source_name,
            ), {
                "mode": "fallback",
                "model": model_name,
                "llm_error": str(exc),
            }

    def _coerce_agent_sample_templates(self, parsed_output: Any, raw_output: Any) -> list[dict[str, Any]]:
        if isinstance(parsed_output, list):
            return [self._safe_record(item) for item in parsed_output if isinstance(item, dict)]
        if isinstance(parsed_output, dict):
            samples = self._safe_list(parsed_output.get("samples"))
            if not samples:
                samples = self._safe_list(parsed_output.get("items"))
            return [self._safe_record(item) for item in samples if isinstance(item, dict)]
        if isinstance(raw_output, str):
            parsed = self._extract_json_object(raw_output)
            if parsed is None:
                return []
            return self._coerce_agent_sample_templates(parsed, parsed)
        return []

    def _build_agent_sample_fallbacks(
        self,
        *,
        count: int,
        dimensions: list[str],
        with_reference: bool,
        source_name: str,
    ) -> list[dict[str, Any]]:
        scenarios = self._agent_scenario_cycle(dimensions)
        scenario_cn = {
            "single_turn": "单轮问答",
            "multi_turn": "多轮对话",
            "tool_calling": "工具调用",
            "open_task": "开放任务",
        }
        samples: list[dict[str, Any]] = []
        for index in range(count):
            scenario = scenarios[index % len(scenarios)]
            title = f"{source_name}{scenario_cn.get(scenario, '问答')}样本{index + 1}"
            conversation_history: list[dict[str, Any]] = []
            if scenario == "multi_turn":
                conversation_history = [{"role": "user", "content": "请先总结该智能体的核心目标。"}]

            tools_context: list[dict[str, Any]] = []
            if scenario == "tool_calling":
                tools_context = [
                    {
                        "name": "search_knowledge",
                        "description": "检索知识库信息",
                        "input_schema": {"query": "string"},
                    }
                ]

            user_input = {
                "single_turn": f"你好，我想先了解一下你在{source_name}场景下能帮我做什么？",
                "multi_turn": f"延续刚才的话题，请你继续给我一个更具体的{source_name}建议。",
                "tool_calling": f"请使用你可用的工具，帮我处理一个与{source_name}相关的问题并解释结果。",
                "open_task": f"我需要一个完整方案：请围绕{source_name}给我可执行步骤。",
            }.get(scenario, f"你好，请你围绕{source_name}给我一个具体建议。")

            item: dict[str, Any] = {
                "name": title,
                "description": f"{scenario_cn.get(scenario, '问答')}自动样本",
                "scenario_type": scenario,
                "user_input": user_input,
                "conversation_history": conversation_history,
                "tools_context": tools_context,
                "constraints": {"language": "zh", "format": "text"},
            }
            if with_reference:
                item["reference_answer"] = {"answer": f"{source_name}样本{index + 1}参考答案"}
            samples.append(item)
        return samples

    def _generate_agent_scoring_rule_templates(
        self,
        *,
        project_id: int,
        source_text: str,
        source_name: str,
        dimensions: list[str],
        with_reference: bool,
        count: int,
        rule_note: str,
        model_name: str,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        prompt = (
            "你是智能体评测规则生成器。请根据 Agent 文档生成多条评分规则，返回 JSON。\n"
            "要求：\n"
            "1) 输出 rules 数组，数量与 count 一致。\n"
            "2) 每条规则必须包含 name、description、match_type、threshold、judge_prompt、dimensions。\n"
            "3) dimensions 是数组，每项包含 name/weight/description。\n"
            "4) weight 合计应为 1.0。\n"
            "5) match_type 仅允许 exact_match/json_match/llm_judge/rule_based。\n"
            "输出格式：\n"
            "{\n"
            '  "rules": [\n'
            "    {\n"
            '      "name": "规则名称",\n'
            '      "description": "规则描述",\n'
            '      "match_type": "llm_judge",\n'
            '      "threshold": 0.8,\n'
            '      "judge_prompt": "评分提示词",\n'
            '      "dimensions": [\n'
            '        {"name":"correctness","weight":0.5,"description":"回答是否准确"}\n'
            "      ]\n"
            "    }\n"
            "  ]\n"
            "}"
        )
        user_input = {
            "source_name": source_name,
            "source_excerpt": source_text[:8000],
            "with_reference": with_reference,
            "dimensions": dimensions,
            "count": count,
            "rule_note": rule_note,
        }

        try:
            llm_config: dict[str, Any] = {
                "model": model_name,
                "base_url": CASE_GEN_DEFAULT_BASE_URL,
                "temperature": 0.2,
            }
            if CASE_GEN_DEFAULT_API_KEY:
                llm_config["api_key"] = CASE_GEN_DEFAULT_API_KEY

            llm_result = self.model_gateway_client.complete(
                project_id=project_id,
                prompt=prompt,
                user_input=user_input,
                context={"task": "agent_scoring_rule_generation"},
                config=llm_config,
            )
            templates = self._coerce_scoring_rule_templates(llm_result.get("parsed_output"), llm_result.get("raw_output"))
            if templates:
                return templates[:count], {"mode": "llm", "model": llm_result.get("model_name") or model_name}
            return self._build_scoring_rule_fallbacks(
                count=count,
                with_reference=with_reference,
                dimensions=dimensions,
                source_name=source_name,
                rule_note=rule_note,
            ), {
                "mode": "fallback",
                "model": llm_result.get("model_name") or model_name,
                "llm_error": "llm 返回结构不合法，已回退规则生成",
            }
        except Exception as exc:  # noqa: BLE001
            return self._build_scoring_rule_fallbacks(
                count=count,
                with_reference=with_reference,
                dimensions=dimensions,
                source_name=source_name,
                rule_note=rule_note,
            ), {
                "mode": "fallback",
                "model": model_name,
                "llm_error": str(exc),
            }

    def _coerce_scoring_rule_templates(self, parsed_output: Any, raw_output: Any) -> list[dict[str, Any]]:
        if isinstance(parsed_output, list):
            return [self._safe_record(item) for item in parsed_output if isinstance(item, dict)]
        if isinstance(parsed_output, dict):
            rules = self._safe_list(parsed_output.get("rules"))
            if not rules:
                rules = self._safe_list(parsed_output.get("items"))
            return [self._safe_record(item) for item in rules if isinstance(item, dict)]
        if isinstance(raw_output, str):
            parsed = self._extract_json_object(raw_output)
            if parsed is None:
                return []
            return self._coerce_scoring_rule_templates(parsed, parsed)
        return []

    def _build_scoring_rule_fallbacks(
        self,
        *,
        count: int,
        with_reference: bool,
        dimensions: list[str],
        source_name: str,
        rule_note: str,
    ) -> list[dict[str, Any]]:
        base_dimension_candidates = [
            {
                "name": "correctness",
                "description": "回答是否准确",
            },
            {
                "name": "completeness",
                "description": "是否覆盖关键信息",
            },
            {
                "name": "format_compliance",
                "description": "输出格式是否满足要求",
            },
            {
                "name": "reasoning_clarity",
                "description": "推理与表达是否清晰",
            },
        ]
        if "tool_calling" in dimensions:
            base_dimension_candidates.append(
                {
                    "name": "tool_usage",
                    "description": "工具调用是否正确且必要",
                }
            )

        rules: list[dict[str, Any]] = []
        for index in range(count):
            matched_type = "json_match" if with_reference and index == 0 else "llm_judge"
            selected_dimensions = base_dimension_candidates[: max(3, min(len(base_dimension_candidates), 3 + (index % 2)))]
            weight = round(1.0 / len(selected_dimensions), 3)
            normalized_dimensions = [
                {"name": item["name"], "weight": weight, "description": item["description"]}
                for item in selected_dimensions
            ]
            if normalized_dimensions:
                drift = round(1.0 - sum(float(item["weight"]) for item in normalized_dimensions), 3)
                normalized_dimensions[0]["weight"] = round(float(normalized_dimensions[0]["weight"]) + drift, 3)

            rules.append(
                {
                    "name": f"{source_name}智能体评价规则{index + 1}",
                    "description": rule_note or "自动生成的智能体质量评分规则",
                    "match_type": matched_type,
                    "threshold": 0.8,
                    "judge_prompt": "请按维度打分并给出理由，严格输出 JSON。",
                    "dimensions": normalized_dimensions,
                }
            )
        return rules

    def _normalize_agent_dimensions(self, value: Any) -> list[str]:
        mapping = {
            "single_turn": "single_turn",
            "single": "single_turn",
            "单轮问答": "single_turn",
            "multi_turn": "multi_turn",
            "multi": "multi_turn",
            "多轮对话": "multi_turn",
            "tool_calling": "tool_calling",
            "tool": "tool_calling",
            "工具调用": "tool_calling",
            "open_task": "open_task",
            "open": "open_task",
            "开放式任务": "open_task",
        }
        result: list[str] = []
        raw_list = self._safe_list(value)
        for item in raw_list:
            if not isinstance(item, str):
                continue
            key = item.strip().lower()
            normalized = mapping.get(key)
            if normalized and normalized not in result:
                result.append(normalized)
        if not result:
            result = ["single_turn"]
        return result

    def _normalize_agent_user_input(
        self,
        *,
        raw_user_input: Any,
        scenario_type: str,
        source_name: str,
        source_text: str,
        index: int,
    ) -> str:
        banned_tokens = ("根据文档", "基于文档", "完成任务", "样本", "sample")
        cleaned_input = ""
        if isinstance(raw_user_input, str):
            cleaned_input = re.sub(r"\s+", " ", raw_user_input).strip()
            if cleaned_input and len(cleaned_input) <= 240:
                lowered = cleaned_input.lower()
                if all(token not in cleaned_input and token not in lowered for token in banned_tokens):
                    return cleaned_input

        topic_hint = self._extract_agent_topic_hint(source_name=source_name, source_text=source_text)
        variant = index % 5
        if scenario_type == "single_turn":
            variants = [
                f"我最近在{topic_hint}上有点烦，因为……你能先听我说说吗？",
                f"我这两天一直在想{topic_hint}，越想越焦虑，你能帮我理一理吗？",
                f"我感觉自己在{topic_hint}上卡住了，有点丧，你会怎么安慰我、再给点建议？",
                f"关于{topic_hint}我有点不好意思开口，但还是想问你：我这样正常吗？",
                f"我现在脑子很乱，事情跟{topic_hint}有关，你能不能先陪我聊两句？",
            ]
            return variants[variant]
        if scenario_type == "multi_turn":
            variants = [
                f"你刚才说得挺有道理，但我还是有点慌。就{topic_hint}这事，你觉得我下一步该怎么走？",
                f"我试着按你说的做了，可我还是很难受。是不是我哪里想错了？跟{topic_hint}有关。",
                f"如果换成你是我，你会怎么开口/怎么处理？我说的是{topic_hint}这个场景。",
                f"我担心自己会搞砸。关于{topic_hint}，你能不能陪我把最坏情况也想一遍？",
                f"我其实更在意的是“我是不是不够好”。这跟{topic_hint}有关，你能懂我在说什么吗？",
            ]
            return variants[variant]
        if scenario_type == "tool_calling":
            variants = [
                f"我有点担心自己理解错了。你能不能查一下{topic_hint}相关的靠谱说法，然后用人话跟我讲讲？",
                f"我刷到很多关于{topic_hint}的说法越看越慌，你能帮我核对一下哪些是真的、哪些是夸大吗？",
                f"我想把{topic_hint}这件事弄清楚，但信息太杂了。你能查完后帮我总结成我能照做的建议吗？",
                f"我朋友跟我说……（关于{topic_hint}）。你能帮我查证一下，然后告诉我该怎么回应吗？",
                f"我想确认一下我是不是被误导了。你用工具查查{topic_hint}，再告诉我一个更稳的判断方式。",
            ]
            return variants[variant]
        if scenario_type == "open_task":
            variants = [
                f"我想认真把{topic_hint}这件事处理好，但我现在状态很差。你能边安慰我边帮我慢慢捋一个方向吗？",
                f"我现在有点崩溃，因为{topic_hint}。你能不能先帮我把问题拆开，让我感觉没那么无助？",
                f"我不想再内耗了。关于{topic_hint}，你能帮我做个循序渐进的调整计划吗？",
                f"我希望你像朋友一样跟我一起想办法：{topic_hint}这事我该怎么开始、怎么坚持？",
                f"我需要一个能落地的方案，但请你用聊天的方式带着我做，不要像说明书那样。",
            ]
            return variants[variant]
        return f"你好，请围绕{topic_hint}给我一个具体建议。"

    def _extract_agent_topic_hint(self, *, source_name: str, source_text: str) -> str:
        normalized_text = re.sub(r"[#>*`]+", " ", str(source_text or ""))
        normalized_text = re.sub(r"\s+", " ", normalized_text).strip()
        for piece in re.split(r"[。！？!?；;\n]", normalized_text):
            candidate = piece.strip()
            if len(candidate) < 6:
                continue
            candidate = re.sub(r"^你(叫|是)|^我是", "", candidate).strip(" ：:-")
            if len(candidate) >= 4:
                return candidate[:22]
        cleaned_name = re.sub(r"\s+", "", str(source_name or "智能体"))[:12]
        return cleaned_name or "当前问题"

    def _agent_scenario_cycle(self, dimensions: list[str]) -> list[str]:
        ordered: list[str] = []
        for item in ["single_turn", "multi_turn", "tool_calling", "open_task"]:
            if item in dimensions:
                ordered.append(item)
        return ordered or ["single_turn"]

    def _normalize_agent_scenario(self, value: Any) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"single_turn", "multi_turn", "tool_calling", "open_task"}:
            return normalized
        return "single_turn"

    def _normalize_agent_case_name(self, *, raw_name: Any, scenario_type: str, index: int, source_name: str) -> str:
        if isinstance(raw_name, str):
            cleaned = re.sub(r"\s+", "", raw_name).strip()
            if 4 <= len(cleaned) <= 40 and not re.fullmatch(r"(案例|测试|样本)\d+", cleaned):
                return cleaned
        base = re.sub(r"\s+", "", source_name)[:10] or "智能体"
        # 按需求：Benchmark 名称保持一致（不加序号）
        return base

    def _normalize_scoring_dimensions(self, value: Any) -> list[dict[str, Any]]:
        items = self._safe_list(value)
        result: list[dict[str, Any]] = []

        for item in items:
            if isinstance(item, str):
                name = item.strip()
                if not name:
                    continue
                result.append({"name": name, "weight": 0.0, "description": f"{name}评分维度"})
                continue

            record = self._safe_record(item)
            name = str(record.get("name") or "").strip()
            if not name:
                continue
            raw_weight = record.get("weight", 0.0)
            try:
                weight = float(raw_weight)
            except (TypeError, ValueError):
                weight = 0.0
            if weight < 0:
                weight = 0.0
            result.append(
                {
                    "name": name,
                    "weight": weight,
                    "description": str(record.get("description") or "").strip() or f"{name}评分维度",
                }
            )

        if not result:
            return []

        total = sum(float(item["weight"]) for item in result)
        if total <= 0:
            default_weight = round(1.0 / len(result), 3)
            for item in result:
                item["weight"] = default_weight
            drift = round(1.0 - sum(float(item["weight"]) for item in result), 3)
            result[0]["weight"] = round(float(result[0]["weight"]) + drift, 3)
            return result

        for item in result:
            item["weight"] = round(float(item["weight"]) / total, 3)
        drift = round(1.0 - sum(float(item["weight"]) for item in result), 3)
        result[0]["weight"] = round(float(result[0]["weight"]) + drift, 3)
        return result

    def _default_scoring_dimensions(self, dimensions: list[str]) -> list[dict[str, Any]]:
        base = [
            {"name": "correctness", "weight": 0.5, "description": "回答是否准确"},
            {"name": "completeness", "weight": 0.3, "description": "是否覆盖关键信息"},
            {"name": "format_compliance", "weight": 0.2, "description": "格式是否满足要求"},
        ]
        if "tool_calling" in dimensions:
            base = [
                {"name": "correctness", "weight": 0.4, "description": "回答是否准确"},
                {"name": "tool_usage", "weight": 0.3, "description": "工具调用是否正确"},
                {"name": "completeness", "weight": 0.2, "description": "是否覆盖关键信息"},
                {"name": "format_compliance", "weight": 0.1, "description": "格式是否满足要求"},
            ]
        return base

    def _normalize_scoring_rule_name(self, *, raw_name: Any, source_name: str, index: int) -> str:
        if isinstance(raw_name, str):
            cleaned = re.sub(r"\s+", "", raw_name).strip()
            if 4 <= len(cleaned) <= 60 and not re.fullmatch(r"(规则)\d+", cleaned):
                return cleaned
        base = re.sub(r"\s+", "", source_name)[:12] or "智能体"
        return f"{base}评价规则{index}"

    def _extract_json_object(self, text: str) -> Any:
        stripped = text.strip()
        if not stripped:
            return None
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

        fence_match = re.search(r"```(?:json)?\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*```", stripped, re.IGNORECASE)
        if fence_match:
            candidate = fence_match.group(1)
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                return None

        bracket_match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", stripped)
        if bracket_match:
            candidate = bracket_match.group(1)
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                return None
        return None

    def _default_body(self, schema: dict[str, Any] | None, *, include_required_only: bool) -> dict[str, Any]:
        if not isinstance(schema, dict):
            return {}
        properties = self._safe_record(schema.get("properties"))
        required = {str(item) for item in self._safe_list(schema.get("required")) if isinstance(item, str)}
        result: dict[str, Any] = {}
        for key, raw_schema in properties.items():
            prop_schema = self._safe_record(raw_schema)
            should_include = (
                key in required
                or prop_schema.get("example") is not None
                or prop_schema.get("default") is not None
                or not include_required_only
            )
            if should_include:
                result[key] = self._sample_by_schema(key, prop_schema, prop_schema.get("example"))
        return result

    def _first_numeric_field(self, schema: dict[str, Any] | None) -> str | None:
        if not isinstance(schema, dict):
            return None
        properties = self._safe_record(schema.get("properties"))
        for key, raw_schema in properties.items():
            schema_item = self._safe_record(raw_schema)
            if schema_item.get("type") in {"number", "integer"}:
                return key
        return None

    def _normalize_case_name(
        self,
        *,
        raw_name: Any,
        feature_hint: str,
        scenario_type: str,
        status_code: int,
        index: int,
    ) -> str:
        if isinstance(raw_name, str):
            cleaned = re.sub(r"\s+", "", raw_name).strip()
            if 8 <= len(cleaned) <= 30 and not re.fullmatch(r"(案例|测试)\d+", cleaned):
                return cleaned
        scenario_cn = {
            "normal": "正常调用",
            "validation": "参数校验",
            "boundary": "边界值",
            "auth": "鉴权",
            "exception": "异常",
        }.get(scenario_type, "接口")
        compact_hint = re.sub(r"\s+", "", feature_hint)[:12] or "接口能力"
        result = f"{compact_hint}{scenario_cn}返回{status_code}"
        if len(result) < 8:
            result = f"{result}场景{index + 1}"
        return result[:30]

    def _resolve_path(self, path_template: str, path_params: dict[str, str]) -> str:
        def replacer(match: re.Match[str]) -> str:
            key = match.group(1)
            return str(path_params.get(key, f"{key}_sample"))

        resolved = re.sub(r"\{([^}]+)\}", replacer, path_template)
        return resolved if resolved.startswith("/") else f"/{resolved}"

    def _load_openapi_document(self, api_doc_asset: dict[str, Any]) -> dict[str, Any]:
        content_json = api_doc_asset.get("content_json")
        if isinstance(content_json, dict) and content_json.get("paths"):
            return content_json
        content_text = api_doc_asset.get("content_text")
        if isinstance(content_text, str) and content_text.strip():
            try:
                parsed = json.loads(content_text)
            except json.JSONDecodeError as exc:
                raise ValueError("API 文档内容不是合法 JSON") from exc
            if isinstance(parsed, dict) and parsed.get("paths"):
                return parsed
        raise ValueError("API 文档中未找到 OpenAPI paths 定义")

    def _extract_text(self, asset: dict[str, Any]) -> str:
        text = asset.get("content_text")
        if isinstance(text, str) and text.strip():
            return text.strip()
        content_json = asset.get("content_json")
        if isinstance(content_json, dict):
            return json.dumps(content_json, ensure_ascii=False)
        return ""

    def _resolve_reference(self, root: dict[str, Any], value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        ref = value.get("$ref")
        if not isinstance(ref, str) or not ref.startswith("#/"):
            return value
        target: Any = root
        for part in ref[2:].split("/"):
            if not isinstance(target, dict) or part not in target:
                return value
            target = target[part]
        if isinstance(target, dict):
            merged = dict(target)
            for key, val in value.items():
                if key != "$ref":
                    merged[key] = val
            return merged
        return target

    def _resolve_schema(self, root: dict[str, Any], schema: dict[str, Any], depth: int = 0) -> dict[str, Any]:
        if depth > 8:
            return schema
        resolved = self._safe_record(self._resolve_reference(root, schema))
        properties = self._safe_record(resolved.get("properties"))
        if properties:
            next_properties: dict[str, Any] = {}
            for key, raw_schema in properties.items():
                next_properties[key] = self._resolve_schema(root, self._safe_record(raw_schema), depth + 1)
            resolved["properties"] = next_properties
        items = resolved.get("items")
        if isinstance(items, dict):
            resolved["items"] = self._resolve_schema(root, items, depth + 1)
        return resolved

    def _serialize_param(self, parameter: ParameterSpec) -> dict[str, Any]:
        return {
            "name": parameter.name,
            "in": parameter.location,
            "required": parameter.required,
            "schema": parameter.schema,
            "example": parameter.example,
        }

    def _sample_by_schema(self, name: str, schema: dict[str, Any], example: Any) -> Any:
        if example is not None:
            return example
        if schema.get("default") is not None:
            return schema.get("default")
        enum_values = self._safe_list(schema.get("enum"))
        if enum_values:
            return enum_values[0]
        schema_type = schema.get("type")
        if schema_type == "string":
            if schema.get("format") == "uuid":
                return "06842ecb-23fe-70a5-8000-74b23bd149b8"
            return f"{name}_sample"
        if schema_type == "integer":
            return 1
        if schema_type == "number":
            return 1
        if schema_type == "boolean":
            return True
        if schema_type == "array":
            return []
        if schema_type == "object":
            properties = self._safe_record(schema.get("properties"))
            required = [str(item) for item in self._safe_list(schema.get("required")) if isinstance(item, str)]
            return {
                key: self._sample_by_schema(key, self._safe_record(properties.get(key)), None)
                for key in required
                if key in properties
            }
        return f"{name}_sample"

    def _normalize_nullable_thread_id(self, *, body: Any, schema: dict[str, Any] | None) -> Any:
        if not isinstance(body, dict):
            return body
        if not isinstance(schema, dict):
            return body

        properties = self._safe_record(schema.get("properties"))
        thread_schema = self._safe_record(properties.get("thread_id"))
        if not thread_schema:
            return body

        schema_type = thread_schema.get("type")
        type_allows_null = isinstance(schema_type, list) and "null" in schema_type
        is_nullable = bool(thread_schema.get("nullable")) or type_allows_null
        if is_nullable:
            body["thread_id"] = None
        return body

    @staticmethod
    def _scenario_cycle(coverage: str) -> list[str]:
        if coverage == "normal":
            return ["normal"]
        if coverage == "boundary":
            return ["boundary", "normal"]
        if coverage == "exception":
            return ["validation", "auth", "exception"]
        return ["normal", "validation", "boundary", "auth"]

    @staticmethod
    def _normalize_scenario(value: Any) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"normal", "validation", "boundary", "auth", "exception"}:
            return normalized
        return "normal"

    @staticmethod
    def _normalize_coverage(value: Any) -> str:
        normalized = str(value or "mixed").strip().lower()
        if normalized in {"mixed", "normal", "boundary", "exception"}:
            return normalized
        return "mixed"

    @staticmethod
    def _looks_like_auth_header(name: str) -> bool:
        lowered = name.strip().lower()
        return "authorization" in lowered or "cookie" in lowered or "token" in lowered

    @staticmethod
    def _optional_positive_int(value: Any, *, field_name: str = "api_doc_asset_id") -> int | None:
        if value in {None, ""}:
            return None
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{field_name} must be an integer") from None
        if parsed <= 0:
            raise ValueError(f"{field_name} must be positive")
        return parsed

    @staticmethod
    def _must_int(value: Any, field_name: str) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{field_name} is required") from None
        if parsed <= 0:
            raise ValueError(f"{field_name} must be positive")
        return parsed

    @staticmethod
    def _random_batch_id() -> str:
        now = datetime.now(timezone.utc)
        return f"api_batch_{now.strftime('%Y%m%d%H%M%S')}"

    @staticmethod
    def _random_agent_batch_id() -> str:
        now = datetime.now(timezone.utc)
        return f"agent_batch_{now.strftime('%Y%m%d%H%M%S')}"

    @staticmethod
    def _safe_record(value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _safe_list(value: Any) -> list[Any]:
        return value if isinstance(value, list) else []
