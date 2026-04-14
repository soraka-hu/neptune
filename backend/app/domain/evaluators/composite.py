from __future__ import annotations

from typing import Any


class CompositeEvaluator:
    def evaluate(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        evaluator_config: dict[str, Any],
        evaluator_factory,
    ) -> dict[str, Any]:
        configs = evaluator_config.get("evaluators") or []
        threshold = float(evaluator_config.get("threshold", 0.0))
        if not configs:
            raise ValueError("missing evaluators")

        dimensions: list[dict[str, Any]] = []
        total_score = 0.0
        total_weight = 0.0

        for config in configs:
            evaluator = evaluator_factory(config["type"])
            weight = float(config.get("weight", 1.0))
            result = evaluator.evaluate(
                case_or_item=case_or_item,
                output=output,
                expected=expected,
                config=config,
            )
            score = float(result.get("score", 0.0))
            total_score += score * weight
            total_weight += weight
            result_dimensions = result.get("dimensions") or []
            primary_dimension = result_dimensions[0] if result_dimensions else {}
            dimensions.append(
                {
                    "name": primary_dimension.get("name", config["type"]),
                    "score": score,
                    "weight": weight,
                    "reason": primary_dimension.get("reason", result.get("reason", "")),
                }
            )

        normalized = total_score / total_weight if total_weight else 0.0
        return {
            "total_score": round(normalized, 4),
            "passed": normalized >= threshold,
            "threshold": threshold,
            "dimensions": dimensions,
        }
