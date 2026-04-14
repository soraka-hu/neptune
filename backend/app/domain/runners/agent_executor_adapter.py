from __future__ import annotations

from typing import Any

from app.infrastructure.llm.model_gateway_client import ModelGatewayClient


class AgentExecutorAdapter:
    def __init__(self, model_gateway_client: ModelGatewayClient | None = None) -> None:
        self.model_gateway_client = model_gateway_client or ModelGatewayClient()

    def execute(
        self,
        *,
        case_item: dict[str, Any],
        dataset_item: dict[str, Any],
        environment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        case_input = case_item.get("input_payload") or {}
        dataset_input = dataset_item.get("input_data") or {}
        reference_answer = dataset_item.get("reference_answer") or (
            (case_item.get("expected_output") or {}).get("reference_answer")
        )

        assembled_input = {
            "user_input": dataset_input.get("user_input") or case_input.get("user_input"),
            "conversation_history": case_input.get("conversation_history") or [],
            "tools_context": case_input.get("tools_context") or [],
            "constraints": case_input.get("constraints") or {},
            "environment_base_url": (environment or {}).get("base_url"),
        }
        user_input = assembled_input.get("user_input")
        if not isinstance(user_input, str) or not user_input.strip():
            return {
                "status": "failed",
                "error_info": {"type": "invalid_input", "message": "missing user_input for agent execution"},
                "request_data": {
                    "assembled_input": assembled_input,
                    "dataset_item_id": dataset_item.get("id"),
                    "case_version": case_item.get("version"),
                },
                "response_data": None,
                "parsed_output": None,
            }

        prompt = "You are an agent under evaluation. Follow user constraints and return your final answer."
        if isinstance(case_input.get("system_prompt"), str) and case_input["system_prompt"].strip():
            prompt = case_input["system_prompt"].strip()

        gateway_config = {}
        if isinstance(case_input.get("model_config"), dict):
            gateway_config = case_input["model_config"]

        try:
            completion = self.model_gateway_client.complete(
                project_id=case_item.get("project_id") if isinstance(case_item.get("project_id"), int) else None,
                prompt=prompt,
                user_input=user_input,
                context={
                    "conversation_history": assembled_input.get("conversation_history"),
                    "tools_context": assembled_input.get("tools_context"),
                    "constraints": assembled_input.get("constraints"),
                    "reference_answer": reference_answer,
                },
                config=gateway_config,
            )
        except Exception as exc:  # noqa: BLE001
            return {
                "status": "failed",
                "error_info": {"type": "agent_execution_error", "message": str(exc)},
                "request_data": {
                    "assembled_input": assembled_input,
                    "dataset_item_id": dataset_item.get("id"),
                    "case_version": case_item.get("version"),
                },
                "response_data": None,
                "parsed_output": None,
            }

        return {
            "status": "success",
            "request_data": {
                "assembled_input": assembled_input,
                "dataset_item_id": dataset_item.get("id"),
                "case_version": case_item.get("version"),
                "model_name": completion.get("model_name"),
            },
            "response_data": {
                "raw_output": completion.get("raw_output"),
                "raw_response": completion.get("raw_response"),
            },
            "parsed_output": completion.get("parsed_output"),
        }
