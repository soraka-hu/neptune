from __future__ import annotations

from app.infrastructure.mq.celery_app import celery_app


@celery_app.task(name="report.process_task")
def process_report_task(run_id: int):
    return {"run_id": run_id, "status": "queued"}
