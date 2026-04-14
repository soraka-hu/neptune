from __future__ import annotations

from typing import Any

from app.domain.evaluators.base import BaseEvaluator
from app.infrastructure.llm.model_gateway_client import ModelGatewayClient


class LLMJudgeEvaluator(BaseEvaluator):
    evaluator_type = "llm_judge"

    def __init__(self, model_gateway_client: ModelGatewayClient | None = None) -> None:
        self.model_gateway_client = model_gateway_client or ModelGatewayClient()

    def evaluate(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        result = self.model_gateway_client.judge(
            prompt=config.get("prompt_template", "Judge the output"),
            output=output,
            expected=expected,
            config=config,
            case_or_item=case_or_item,
        )
        dimensions = result.get("dimensions") if isinstance(result.get("dimensions"), list) else []

        configured_dimensions = config.get("dimensions") if isinstance(config.get("dimensions"), list) else []
        weight_map: dict[str, float] = {}
        configured_name_order: list[str] = []
        for item in configured_dimensions:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            configured_name_order.append(name)
            try:
                weight = float(item.get("weight", 0.0))
            except (TypeError, ValueError):
                weight = 0.0
            if weight > 0:
                weight_map[name] = weight

        normalized_dimensions: list[dict[str, Any]] = []
        overall_score = float(result.get("score", 0.0))
        overall_reason = result.get("reason", "judge result")

        if configured_name_order:
            raw_dimension_map: dict[str, dict[str, Any]] = {}
            normalized_raw_dimensions: list[dict[str, Any]] = []
            for item in dimensions:
                if not isinstance(item, dict):
                    continue
                raw_name = str(item.get("name") or "").strip()
                if not raw_name:
                    continue
                key = raw_name.lower()
                raw_dimension_map[key] = item
                normalized_raw_dimensions.append(item)

            for index, configured_name in enumerate(configured_name_order):
                matched = raw_dimension_map.get(configured_name.lower())
                if matched is None and index < len(normalized_raw_dimensions):
                    matched = normalized_raw_dimensions[index]

                normalized_item = {
                    "name": configured_name,
                    "score": float(matched.get("score", overall_score)) if isinstance(matched, dict) else overall_score,
                    "reason": matched.get("reason", overall_reason) if isinstance(matched, dict) else overall_reason,
                }
                if configured_name in weight_map:
                    normalized_item["weight"] = weight_map[configured_name]
                normalized_dimensions.append(normalized_item)
        else:
            for item in dimensions:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or "llm_judge")
                normalized_item = {
                    "name": name,
                    "score": float(item.get("score", overall_score)),
                    "reason": item.get("reason", overall_reason),
                }
                if name in weight_map:
                    normalized_item["weight"] = weight_map[name]
                normalized_dimensions.append(normalized_item)

        if not normalized_dimensions:
            normalized_dimensions = [
                {
                    "name": configured_name_order[0] if configured_name_order else "llm_judge",
                    "score": overall_score,
                    "reason": overall_reason,
                }
            ]
            if configured_name_order and configured_name_order[0] in weight_map:
                normalized_dimensions[0]["weight"] = weight_map[configured_name_order[0]]

        weighted_sum = 0.0
        weight_total = 0.0
        for item in normalized_dimensions:
            score = float(item.get("score", 0.0))
            weight = float(item.get("weight", 0.0))
            if weight > 0:
                weighted_sum += score * weight
                weight_total += weight
        if weight_total > 0:
            final_score = weighted_sum / weight_total
        else:
            final_score = sum(float(item.get("score", 0.0)) for item in normalized_dimensions) / max(1, len(normalized_dimensions))

        return {
            "score": final_score,
            "reason": overall_reason,
            "dimensions": normalized_dimensions,
            "model_name": result.get("model_name"),
            "model_version": result.get("model_version"),
        }
