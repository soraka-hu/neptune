from __future__ import annotations

from app.infrastructure.mq.celery_app import celery_app


@celery_app.task(name="generation.process_task")
def process_generation_task(task_id: str):
    return {"task_id": task_id, "status": "queued"}

