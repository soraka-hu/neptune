from __future__ import annotations


class RunStateMachine:
    _TRANSITIONS = {
        "pending": {"queued", "canceled"},
        "queued": {"running", "canceled", "failed", "timeout"},
        "running": {"partially_success", "success", "failed", "canceled", "timeout"},
        "partially_success": {"queued", "success", "failed", "canceled", "timeout"},
        "success": set(),
        "failed": {"queued"},
        "canceled": set(),
        "timeout": {"queued"},
    }

    @classmethod
    def validate_transition(cls, current_status: str, next_status: str) -> None:
        if current_status == next_status:
            return
        allowed = cls._TRANSITIONS.get(current_status)
        if allowed is None or next_status not in allowed:
            raise ValueError(f"invalid run status transition: {current_status} -> {next_status}")
