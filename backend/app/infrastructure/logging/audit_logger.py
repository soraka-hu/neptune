from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from typing import Any


class AuditLogger:
    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._lock = Lock()

    def log_event(
        self,
        *,
        request_id: str,
        method: str,
        path: str,
        status_code: int,
        actor: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        event = {
            "request_id": request_id,
            "method": method,
            "path": path,
            "status_code": status_code,
            "actor": actor,
            "meta": meta or {},
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            self._events.append(event)
        return event

    def get_events(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(event) for event in self._events]

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


audit_logger = AuditLogger()
