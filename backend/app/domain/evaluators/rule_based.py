from __future__ import annotations

import json
from typing import Any

from app.domain.evaluators.base import BaseEvaluator


class RuleBasedEvaluator(BaseEvaluator):
    evaluator_type = "rule_based"

    def evaluate(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        rules = list(config.get("rules") or [])
        must_include = expected.get("must_include") if isinstance(expected, dict) else None
        if must_include:
            rules.append({"type": "must_include", "values": must_include})

        output_text = self._stringify(output)
        dimensions: list[dict[str, Any]] = []
        passed_rules = 0

        for index, rule in enumerate(rules, start=1):
            rule_type = rule.get("type")
            if rule_type == "must_include":
                values = rule.get("values") or []
                missing = [value for value in values if value not in output_text]
                passed = not missing
                reason = "all required values present" if passed else f"missing values: {', '.join(missing)}"
            else:
                passed = False
                reason = f"unsupported rule type: {rule_type}"
            if passed:
                passed_rules += 1
            dimensions.append(
                {
                    "name": rule_type or f"rule_{index}",
                    "score": 1.0 if passed else 0.0,
                    "reason": reason,
                }
            )

        if not dimensions:
            dimensions.append({"name": "rule_based", "score": 1.0, "reason": "no rules configured"})
            score = 1.0
        else:
            score = passed_rules / len(dimensions)

        return {
            "score": score,
            "reason": "rules passed" if score == 1.0 else "some rules failed",
            "dimensions": dimensions,
        }

    @staticmethod
    def _stringify(value: Any) -> str:
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
