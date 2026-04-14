from __future__ import annotations

from typing import Any

from app.domain.evaluators.base import BaseEvaluator


class ExactMatchEvaluator(BaseEvaluator):
    evaluator_type = "exact_match"

    def evaluate(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        reference = expected.get("reference_answer", expected) if isinstance(expected, dict) else expected
        score = 1.0 if output == reference else 0.0
        return {
            "score": score,
            "reason": "exact match" if score == 1.0 else "output does not exactly match reference",
            "dimensions": [
                {
                    "name": "exact_match",
                    "score": score,
                    "reason": "exact match" if score == 1.0 else "mismatch",
                }
            ],
        }
