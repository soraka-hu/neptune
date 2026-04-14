from __future__ import annotations

from typing import Any

from app.domain.evaluators import (
    CompositeEvaluator,
    ExactMatchEvaluator,
    JsonMatchEvaluator,
    LLMJudgeEvaluator,
    RuleBasedEvaluator,
)


class EvaluationService:
    def __init__(self) -> None:
        self.composite_evaluator = CompositeEvaluator()

    def evaluate(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        evaluator_config: dict[str, Any],
    ) -> dict[str, Any]:
        return self.evaluate_with_trace(
            case_or_item=case_or_item,
            output=output,
            expected=expected,
            evaluator_config=evaluator_config,
        )["score_result"]

    def evaluate_with_trace(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        evaluator_config: dict[str, Any],
    ) -> dict[str, Any]:
        configs = evaluator_config.get("evaluators") or []
        threshold = float(evaluator_config.get("threshold", 0.0))
        if not configs:
            raise ValueError("missing evaluators")

        dimensions: list[dict[str, Any]] = []
        evaluator_traces: list[dict[str, Any]] = []
        total_score = 0.0
        total_weight = 0.0

        for config in configs:
            evaluator = self._build_evaluator(config["type"])
            weight = float(config.get("weight", 1.0))
            result = evaluator.evaluate(
                case_or_item=case_or_item,
                output=output,
                expected=expected,
                config=config,
            )
            score = float(result.get("score", 0.0))

            result_dimensions = result.get("dimensions") or []
            dimension_entries: list[dict[str, Any]] = []
            if isinstance(result_dimensions, list) and result_dimensions:
                for dimension in result_dimensions:
                    if not isinstance(dimension, dict):
                        continue
                    entry = {
                        "name": dimension.get("name", config["type"]),
                        "score": float(dimension.get("score", score)),
                        "weight": float(dimension.get("weight", 0.0)),
                        "reason": dimension.get("reason", result.get("reason", "")),
                    }
                    dimension_entries.append(entry)
                    dimensions.append(entry)
            else:
                fallback_entry = {
                    "name": config["type"],
                    "score": score,
                    "weight": 1.0,
                    "reason": result.get("reason", ""),
                }
                dimension_entries.append(fallback_entry)
                dimensions.append(fallback_entry)

            dim_weight_sum = sum(float(item.get("weight", 0.0)) for item in dimension_entries)
            if dim_weight_sum > 0:
                evaluator_score = sum(float(item.get("score", 0.0)) * float(item.get("weight", 0.0)) for item in dimension_entries) / dim_weight_sum
            else:
                evaluator_score = sum(float(item.get("score", 0.0)) for item in dimension_entries) / max(1, len(dimension_entries))

            total_score += evaluator_score * weight
            total_weight += weight
            evaluator_traces.append(
                {
                    "type": config["type"],
                    "config": config,
                    "result": result,
                }
            )

        normalized = total_score / total_weight if total_weight else 0.0
        score_result = {
            "total_score": round(normalized, 4),
            "passed": normalized >= threshold,
            "threshold": threshold,
            "dimensions": dimensions,
        }
        return {
            "score_result": score_result,
            "evaluator_traces": evaluator_traces,
        }

    def evaluate_with_composite(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        evaluator_config: dict[str, Any],
    ) -> dict[str, Any]:
        return self.composite_evaluator.evaluate(
            case_or_item=case_or_item,
            output=output,
            expected=expected,
            evaluator_config=evaluator_config,
            evaluator_factory=self._build_evaluator,
        )

    @staticmethod
    def _build_evaluator(evaluator_type: str):
        evaluators = {
            "exact_match": ExactMatchEvaluator,
            "json_match": JsonMatchEvaluator,
            "json_diff": JsonMatchEvaluator,
            "rule_based": RuleBasedEvaluator,
            "llm_judge": LLMJudgeEvaluator,
        }
        evaluator_cls = evaluators.get(evaluator_type)
        if evaluator_cls is None:
            raise ValueError(f"unsupported evaluator type: {evaluator_type}")
        return evaluator_cls()
