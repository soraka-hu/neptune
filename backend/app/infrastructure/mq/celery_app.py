from __future__ import annotations

import os
from uuid import uuid4


class _TaskStub:
    def __init__(self, func):
        self.func = func
        self.__name__ = getattr(func, "__name__", "task")

    def __call__(self, *args, **kwargs):
        return self.func(*args, **kwargs)

    def delay(self, *args, **kwargs):
        # Local development fallback: execute immediately so run status can progress
        # without requiring an external broker/worker process.
        result = self.func(*args, **kwargs)
        return {"task_id": f"local-{uuid4().hex[:12]}", "args": args, "kwargs": kwargs, "result": result}

    def apply_async(self, args=None, kwargs=None, **_options):
        return self.delay(*(args or ()), **(kwargs or {}))


class _CeleryStub:
    def task(self, *decorator_args, **_decorator_kwargs):
        if decorator_args and callable(decorator_args[0]):
            return _TaskStub(decorator_args[0])

        def wrapper(func):
            return _TaskStub(func)

        return wrapper


def _build_celery_app():
    try:
        from celery import Celery
    except ModuleNotFoundError:
        return _CeleryStub()

    broker_url = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    result_backend = os.getenv("CELERY_RESULT_BACKEND", broker_url)

    app = Celery("unified_test_eval", broker=broker_url, backend=result_backend)
    app.conf.update(
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        timezone="UTC",
        enable_utc=True,
    )
    return app


celery_app = _build_celery_app()
