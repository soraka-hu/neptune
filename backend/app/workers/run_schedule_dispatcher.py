from __future__ import annotations

import logging
import os
from threading import Event, Thread

from app.application.run_schedule_service import RunScheduleService


logger = logging.getLogger(__name__)


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(1, value)


class RunScheduleDispatcher:
    def __init__(self) -> None:
        self.poll_seconds = _int_env("RUN_SCHEDULER_POLL_SECONDS", 15)
        self.batch_size = _int_env("RUN_SCHEDULER_BATCH_SIZE", 20)
        self._stop_event = Event()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = Thread(target=self._run_loop, name="run-schedule-dispatcher", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)

    def _run_loop(self) -> None:
        service = RunScheduleService()
        while not self._stop_event.is_set():
            try:
                service.dispatch_due_schedules(limit=self.batch_size)
            except Exception as exc:  # noqa: BLE001
                logger.warning("run schedule dispatch failed: %s", exc, exc_info=True)
            self._stop_event.wait(self.poll_seconds)


run_schedule_dispatcher = RunScheduleDispatcher()
