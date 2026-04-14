from __future__ import annotations

from app.infrastructure.mq.celery_app import celery_app


@celery_app.task(name="judge.process_task")
def process_judge_task(run_item_id: int):
    return {"run_item_id": run_item_id, "status": "queued"}

