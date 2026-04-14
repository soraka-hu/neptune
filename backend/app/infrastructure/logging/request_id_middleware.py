from __future__ import annotations

from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.infrastructure.logging.audit_logger import audit_logger
from app.infrastructure.monitoring.metrics import metrics_registry


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid4().hex
        if "x-request-id" not in request.headers:
            headers = list(request.scope.get("headers", []))
            headers.append((b"x-request-id", request_id.encode("utf-8")))
            request.scope["headers"] = headers

        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id

        metrics_registry.record_http_request(
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
        )

        if request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            audit_logger.log_event(
                request_id=request_id,
                method=request.method.upper(),
                path=request.url.path,
                status_code=response.status_code,
            )

        return response
