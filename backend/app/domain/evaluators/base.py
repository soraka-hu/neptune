from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseEvaluator(ABC):
    evaluator_type = "base"

    @abstractmethod
    def evaluate(
        self,
        *,
        case_or_item: dict[str, Any],
        output: Any,
        expected: Any,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        raise NotImplementedError
