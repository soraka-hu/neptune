import os

from fastapi import FastAPI

from app.api.dataset_api import router as dataset_router
from app.api.environment_api import router as environment_router
from app.api.evaluator_api import router as evaluator_router
from app.api.health_api import router as health_router
from app.api.case_api import router as case_router
from app.api.case_generation_api import router as case_generation_router
from app.api.report_api import router as report_router
from app.api.run_api import router as run_router
from app.api.run_schedule_api import router as run_schedule_router
from app.api.prompt_api import router as prompt_router
from app.api.project_api import router as project_router
from app.api.rule_api import router as rule_router
from app.api.suite_api import router as suite_router
from app.api.user_asset_api import router as user_asset_router
from app.infrastructure.logging import RequestIdMiddleware
from app.workers.run_schedule_dispatcher import run_schedule_dispatcher

app = FastAPI(title="Unified Test & Eval Platform")
app.add_middleware(RequestIdMiddleware)
app.include_router(health_router)
app.include_router(project_router)
app.include_router(suite_router)
app.include_router(case_router)
app.include_router(case_generation_router)
app.include_router(run_router)
app.include_router(run_schedule_router)
app.include_router(report_router)
app.include_router(rule_router)
app.include_router(dataset_router)
app.include_router(evaluator_router)
app.include_router(environment_router)
app.include_router(prompt_router)
app.include_router(user_asset_router)


@app.on_event("startup")
def startup_run_schedule_dispatcher() -> None:
    enabled = os.getenv("RUN_SCHEDULER_ENABLED", "true").strip().lower()
    if enabled in {"0", "false", "off", "no"}:
        return
    run_schedule_dispatcher.start()


@app.on_event("shutdown")
def shutdown_run_schedule_dispatcher() -> None:
    run_schedule_dispatcher.stop()
