from __future__ import annotations

from threading import Lock
from typing import Any


class MetricsRegistry:
    def __init__(self) -> None:
        self._lock = Lock()
        self._http_requests: dict[tuple[str, str, int], int] = {}
        self._run_status_total: dict[str, int] = {}
        self._evaluator_latency_ms: dict[str, list[float]] = {}

    def record_http_request(self, *, method: str, path: str, status_code: int) -> None:
        key = (method.upper(), path, int(status_code))
        with self._lock:
            self._http_requests[key] = self._http_requests.get(key, 0) + 1

    def increment_run_status(self, status: str) -> None:
        with self._lock:
            self._run_status_total[status] = self._run_status_total.get(status, 0) + 1

    def observe_evaluator_latency(self, evaluator_type: str, latency_ms: float) -> None:
        with self._lock:
            self._evaluator_latency_ms.setdefault(evaluator_type, []).append(float(latency_ms))

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "http_requests_total": {
                    f"{method} {path} {status_code}": count
                    for (method, path, status_code), count in self._http_requests.items()
                },
                "run_status_total": dict(self._run_status_total),
                "evaluator_latency_ms": {
                    evaluator_type: {
                        "count": len(latencies),
                        "avg": (sum(latencies) / len(latencies)) if latencies else 0.0,
                        "max": max(latencies) if latencies else 0.0,
                    }
                    for evaluator_type, latencies in self._evaluator_latency_ms.items()
                },
            }

    def reset(self) -> None:
        with self._lock:
            self._http_requests.clear()
            self._run_status_total.clear()
            self._evaluator_latency_ms.clear()


metrics_registry = MetricsRegistry()
