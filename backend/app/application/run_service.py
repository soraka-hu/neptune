from __future__ import annotations

import os
import logging
from datetime import datetime, timezone
from threading import Thread
from uuid import uuid4

from app.application.project_service import NotFoundError
from app.application.report_service import ReportService
from app.domain.services.run_state_machine import RunStateMachine
from app.infrastructure.repositories.project_repository import ProjectRepository
from app.infrastructure.repositories.rule_repository import RuleRepository
from app.infrastructure.repositories.run_repository import RunRepository
from app.infrastructure.repositories.run_schedule_repository import RunScheduleRepository
from app.infrastructure.repositories.suite_repository import SuiteRepository
from app.infrastructure.repositories.table_repository import TableRepository
from app.workers.execution_worker import execute_run_item

logger = logging.getLogger(__name__)


class RunService:
    def __init__(
        self,
        run_repository: RunRepository | None = None,
        project_repository: ProjectRepository | None = None,
        suite_repository: SuiteRepository | None = None,
        dataset_repository: TableRepository | None = None,
        environment_repository: TableRepository | None = None,
        case_repository: TableRepository | None = None,
        dataset_item_repository: TableRepository | None = None,
        run_item_repository: TableRepository | None = None,
        run_log_repository: TableRepository | None = None,
        rule_repository: RuleRepository | None = None,
        run_schedule_repository: RunScheduleRepository | None = None,
    ) -> None:
        self.run_repository = run_repository or RunRepository()
        self.project_repository = project_repository or ProjectRepository()
        self.suite_repository = suite_repository or SuiteRepository()
        self.dataset_repository = dataset_repository or TableRepository("dataset")
        self.environment_repository = environment_repository or TableRepository("environment")
        self.case_repository = case_repository or TableRepository("case_item")
        self.dataset_item_repository = dataset_item_repository or TableRepository("dataset_item")
        self.run_item_repository = run_item_repository or TableRepository("run_item")
        self.run_log_repository = run_log_repository or TableRepository("run_log")
        self.rule_repository = rule_repository or RuleRepository()
        self.run_schedule_repository = run_schedule_repository or RunScheduleRepository()

    def create_run(self, payload: dict, idempotency_key: str | None) -> dict:
        run_type = payload.get("run_type")
        if run_type not in {"api_test", "agent_eval"}:
            raise ValueError("run_type must be api_test or agent_eval")
        normalized_payload = dict(payload)
        normalized_payload.pop("run_type", None)
        return self._create_run(run_type, normalized_payload, idempotency_key)

    def create_api_run(self, payload: dict, idempotency_key: str | None) -> dict:
        return self._create_run("api_test", payload, idempotency_key)

    def create_agent_eval_run(self, payload: dict, idempotency_key: str | None) -> dict:
        return self._create_run("agent_eval", payload, idempotency_key)

    def preview_rule_binding(self, payload: dict) -> dict:
        run_type = payload.get("run_type")
        if run_type not in {"api_test", "agent_eval"}:
            raise ValueError("run_type must be api_test or agent_eval")

        project_id = payload.get("project_id")
        if not isinstance(project_id, int):
            raise ValueError("project_id is required")
        suite_id = payload.get("suite_id")
        if suite_id is not None and not isinstance(suite_id, int):
            raise ValueError("suite_id must be integer")

        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")

        if suite_id is not None:
            suite = self.suite_repository.get(suite_id)
            if suite is None:
                raise NotFoundError(f"suite {suite_id} not found")
            if suite["project_id"] != project_id:
                raise ValueError("suite does not belong to project")

        resolved = self._resolve_bound_rules(run_type, payload, project_id, suite_id)
        strategy_mode = self._resolve_strategy_mode(run_type, payload)
        strategy_description = self._resolve_strategy_description(strategy_mode)

        return {
            "run_type": run_type,
            "project_id": project_id,
            "suite_id": suite_id,
            "strategy_mode": strategy_mode,
            "strategy_description": strategy_description,
            "rule_types": resolved["bound_rule_types"],
            "selected_rule_ids": resolved["selected_rule_ids"],
            "selected_rules": [self._compact_rule(rule) for rule in resolved["selected_rules"]],
            "auto_bound_rules": [self._compact_rule(rule) for rule in resolved["project_suite_bound_rules"]],
            "effective_rules": [self._compact_rule(rule) for rule in resolved["bound_rules"]],
        }

    def list_runs(
        self,
        project_id: int | None = None,
        suite_id: int | None = None,
        status: str | None = None,
        run_type: str | None = None,
    ) -> list[dict]:
        records = self.run_repository.list(project_id=project_id, suite_id=suite_id, status=status, run_type=run_type)
        return self._with_report_delivery_metadata(records)

    def get_run(self, run_id: int) -> dict:
        record = self.run_repository.get(run_id)
        if record is None:
            raise NotFoundError(f"run {run_id} not found")
        enriched = self._with_report_delivery_metadata([record])
        return enriched[0] if enriched else record

    def list_run_items(self, run_id: int) -> list[dict]:
        self.get_run(run_id)
        return self.run_item_repository.list({"run_id": run_id})

    def list_run_logs(self, run_id: int) -> list[dict]:
        self.get_run(run_id)
        return self.run_log_repository.list({"run_id": run_id})

    def compare_run(self, run_id: int, target_run_id: int | None = None) -> dict:
        current = self.get_run(run_id)
        compare_to = target_run_id
        if compare_to is None:
            all_runs = self.list_runs(project_id=current["project_id"], suite_id=current.get("suite_id"), run_type=current.get("run_type"))
            candidates = [item for item in all_runs if item["id"] != run_id and item["id"] < run_id]
            candidates.sort(key=lambda item: item["id"], reverse=True)
            if candidates:
                compare_to = candidates[0]["id"]
        if compare_to is None:
            raise ValueError("no comparable run found")
        self.get_run(compare_to)
        return ReportService().compare_runs(compare_to, run_id)

    def cancel_run(self, run_id: int) -> dict:
        return self._transition_run(run_id, "canceled", {"finished_at": self._utc_now()})

    def retry_failed(self, run_id: int) -> dict:
        return self._transition_run(
            run_id,
            "queued",
            {
                "started_at": None,
                "finished_at": None,
                "progress": 0,
            },
        )

    def delete_run(self, run_id: int) -> dict:
        record = self.get_run(run_id)
        summary = record.get("summary") if isinstance(record.get("summary"), dict) else {}
        next_summary = {**summary, "_deleted": True}
        updated = self.run_repository.update(run_id, {"is_deleted": True, "summary": next_summary})
        if updated is None:
            raise NotFoundError(f"run {run_id} not found")
        return {}

    def _create_run(self, run_type: str, payload: dict, idempotency_key: str | None) -> dict:
        if not idempotency_key:
            raise ValueError("missing Idempotency-Key")
        project_id = payload["project_id"]
        suite_id = payload.get("suite_id")
        dataset_id = payload.get("dataset_id")
        environment_id = payload.get("environment_id")

        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")

        if suite_id is not None:
            suite = self.suite_repository.get(suite_id)
            if suite is None:
                raise NotFoundError(f"suite {suite_id} not found")
            if suite["project_id"] != project_id:
                raise ValueError("suite does not belong to project")

        if dataset_id is not None:
            dataset = self.dataset_repository.get(dataset_id)
            if dataset is None:
                raise NotFoundError(f"dataset {dataset_id} not found")
            if dataset["project_id"] != project_id:
                raise ValueError("dataset does not belong to project")

        if environment_id is not None:
            environment = self.environment_repository.get(environment_id)
            if environment is None:
                raise NotFoundError(f"environment {environment_id} not found")
            if environment["project_id"] != project_id:
                raise ValueError("environment does not belong to project")

        existing = self.run_repository.get_by_idempotency_key(idempotency_key)
        if existing is not None:
            return existing

        request_snapshot = {
            "run_type": run_type,
            "idempotency_key": idempotency_key,
            "project_id": project_id,
            "suite_id": suite_id,
            "dataset_id": dataset_id,
            "environment_id": environment_id,
            "trigger_type": payload.get("trigger_type", "manual"),
            "source_id": payload.get("source_id"),
            "created_by": payload.get("created_by"),
        }
        if isinstance(payload.get("rule_ids"), list):
            request_snapshot["rule_ids"] = [rule_id for rule_id in payload.get("rule_ids", []) if isinstance(rule_id, int)]
        if isinstance(payload.get("execution_rule_id"), int):
            request_snapshot["execution_rule_id"] = int(payload["execution_rule_id"])
        if isinstance(payload.get("scoring_rule_id"), int):
            request_snapshot["scoring_rule_id"] = int(payload["scoring_rule_id"])
        if isinstance(payload.get("execution_config"), dict):
            request_snapshot["execution_config"] = payload.get("execution_config")
        if isinstance(payload.get("evaluation_mode"), str):
            request_snapshot["evaluation_mode"] = payload.get("evaluation_mode")

        resolved_rules = self._resolve_bound_rules(run_type, payload, project_id, suite_id)
        selected_rule_ids = resolved_rules["selected_rule_ids"]
        bound_rules = resolved_rules["bound_rules"]

        request_snapshot["selected_rule_ids"] = selected_rule_ids
        request_snapshot["bound_rule_ids"] = [int(rule["id"]) for rule in bound_rules]
        request_snapshot["bound_rules"] = [
            {
                "id": int(rule["id"]),
                "name": str(rule.get("name")),
                "rule_type": str(rule.get("rule_type")),
                "content": rule.get("content") if isinstance(rule.get("content"), dict) else {},
            }
            for rule in bound_rules
        ]

        record = {
            "run_no": self._generate_run_no(run_type),
            "idempotency_key": idempotency_key,
            "project_id": project_id,
            "suite_id": suite_id,
            "dataset_id": dataset_id,
            "run_type": run_type,
            "trigger_type": payload.get("trigger_type", "manual"),
            "source_id": payload.get("source_id"),
            "environment_id": environment_id,
            "status": "pending",
            "progress": 0,
            "request_snapshot": request_snapshot,
            "summary": {"total": 0, "passed": 0, "failed": 0},
            "created_by": payload.get("created_by"),
        }
        created_run = self.run_repository.create(record)
        run_items = self._create_run_items(created_run["id"], run_type, project_id, suite_id, dataset_id)
        summary = {"total": len(run_items), "passed": 0, "failed": 0}
        queued_run = self.run_repository.update(created_run["id"], {"status": "queued", "summary": summary})
        self._dispatch_run_items(run_items)
        refreshed = self.run_repository.get(created_run["id"])
        return refreshed or queued_run or created_run

    def _with_report_delivery_metadata(self, records: list[dict]) -> list[dict]:
        if not records:
            return records

        source_ids: set[int] = set()
        for record in records:
            source_id = record.get("source_id")
            if isinstance(source_id, int) and source_id > 0:
                source_ids.add(source_id)

        schedule_delivery_enabled: dict[int, bool] = {}
        for source_id in source_ids:
            schedule = self.run_schedule_repository.get(source_id)
            schedule_delivery_enabled[source_id] = self._schedule_has_delivery_enabled(schedule)

        enriched: list[dict] = []
        for record in records:
            next_record = dict(record)
            snapshot = record.get("request_snapshot") if isinstance(record.get("request_snapshot"), dict) else {}
            delivery_snapshot = snapshot.get("report_delivery") if isinstance(snapshot.get("report_delivery"), dict) else {}

            raw_status = str(delivery_snapshot.get("status") or "").strip().lower()
            if raw_status:
                next_record["report_delivery_status"] = raw_status
                error_text = str(delivery_snapshot.get("error") or "").strip()
                next_record["report_delivery_error"] = error_text or None
                attempted_at = delivery_snapshot.get("attempted_at")
                next_record["report_delivery_attempted_at"] = attempted_at if isinstance(attempted_at, str) else None
                enriched.append(next_record)
                continue

            source_id = record.get("source_id")
            should_deliver = (
                isinstance(source_id, int)
                and source_id > 0
                and bool(schedule_delivery_enabled.get(source_id))
            )
            next_record["report_delivery_status"] = "pending" if should_deliver else "disabled"
            next_record["report_delivery_error"] = None
            next_record["report_delivery_attempted_at"] = None
            enriched.append(next_record)
        return enriched

    @staticmethod
    def _schedule_has_delivery_enabled(schedule: dict | None) -> bool:
        if not isinstance(schedule, dict):
            return False
        meta_info = schedule.get("meta_info") if isinstance(schedule.get("meta_info"), dict) else {}
        delivery = meta_info.get("report_delivery") if isinstance(meta_info.get("report_delivery"), dict) else {}
        return bool(delivery.get("enabled")) and isinstance(delivery.get("channel_asset_id"), int)

    @staticmethod
    def _resolve_strategy_mode(run_type: str, payload: dict) -> str:
        if run_type == "api_test":
            if isinstance(payload.get("execution_config"), dict):
                return "custom"
            if isinstance(payload.get("execution_rule_id"), int):
                return "selected_rule"
            return "binding_auto"
        if isinstance(payload.get("scoring_rule_id"), int):
            return "selected_rule"
        return "binding_auto"

    @staticmethod
    def _resolve_strategy_description(strategy_mode: str) -> str:
        if strategy_mode == "custom":
            return "使用自定义执行配置（execution_config）"
        if strategy_mode == "selected_rule":
            return "使用手动选择规则，并叠加项目/Suite 绑定规则"
        return "自动加载项目/Suite 绑定规则"

    def _resolve_bound_rules(self, run_type: str, payload: dict, project_id: int, suite_id: int | None) -> dict:
        bound_rule_types = ["assertion"] if run_type == "api_test" else ["scoring"]
        selected_rule_ids = payload.get("rule_ids") if isinstance(payload.get("rule_ids"), list) else []
        selected_rule_ids = [int(rule_id) for rule_id in selected_rule_ids if isinstance(rule_id, int)]
        if run_type == "api_test" and isinstance(payload.get("execution_rule_id"), int):
            selected_rule_ids.append(int(payload["execution_rule_id"]))
        if run_type == "agent_eval" and isinstance(payload.get("scoring_rule_id"), int):
            selected_rule_ids.append(int(payload["scoring_rule_id"]))
        selected_rule_ids = sorted(set(selected_rule_ids))

        selected_rules = self.rule_repository.list_by_ids(
            selected_rule_ids,
            rule_types=bound_rule_types,
            only_active=True,
        )
        if selected_rule_ids:
            selected_found = {int(rule["id"]) for rule in selected_rules}
            missing_ids = [rule_id for rule_id in selected_rule_ids if rule_id not in selected_found]
            if missing_ids:
                raise ValueError(
                    f"rule ids not found or unavailable for run type: {','.join(str(rule_id) for rule_id in missing_ids)}"
                )

        project_suite_bound_rules = self.rule_repository.list_bound_rules(
            project_id=project_id,
            suite_id=suite_id,
            rule_types=bound_rule_types,
        )

        merged_rule_map: dict[int, dict] = {}
        for rule in [*selected_rules, *project_suite_bound_rules]:
            merged_rule_map[int(rule["id"])] = rule
        bound_rules = list(merged_rule_map.values())
        custom_execution_config = payload.get("execution_config") if isinstance(payload.get("execution_config"), dict) else None
        if custom_execution_config is not None:
            bound_rules.append(
                {
                    "id": -1,
                    "name": "custom_execution_config",
                    "rule_type": "execution",
                    "status": "active",
                    "content": custom_execution_config,
                }
            )

        return {
            "bound_rule_types": bound_rule_types,
            "selected_rule_ids": selected_rule_ids,
            "selected_rules": selected_rules,
            "project_suite_bound_rules": project_suite_bound_rules,
            "bound_rules": bound_rules,
        }

    @staticmethod
    def _compact_rule(rule: dict) -> dict:
        return {
            "id": int(rule.get("id", -1)),
            "name": str(rule.get("name", "unnamed-rule")),
            "rule_type": str(rule.get("rule_type", "unknown")),
            "status": str(rule.get("status", "active")),
            "description": rule.get("description"),
            "content": rule.get("content") if isinstance(rule.get("content"), dict) else {},
        }

    def _transition_run(self, run_id: int, next_status: str, extra_updates: dict | None = None) -> dict:
        record = self.get_run(run_id)
        RunStateMachine.validate_transition(record["status"], next_status)
        updates = {"status": next_status}
        if extra_updates:
            updates.update(extra_updates)
        updated = self.run_repository.update(run_id, updates)
        if updated is None:
            raise NotFoundError(f"run {run_id} not found")
        return updated

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _generate_run_no(run_type: str) -> str:
        normalized = "".join(ch.lower() if ch.isalnum() else "-" for ch in run_type).strip("-") or "run"
        return f"{normalized[:16]}-{uuid4().hex[:12]}"

    def _create_run_items(
        self,
        run_id: int,
        run_type: str,
        project_id: int,
        suite_id: int | None,
        dataset_id: int | None,
    ) -> list[dict]:
        if run_type == "api_test":
            if suite_id is not None:
                cases = self.case_repository.list({"suite_id": suite_id})
            else:
                cases = self.case_repository.list({"project_id": project_id})
            active_cases = [case for case in cases if case.get("status") != "archived"]
            return [
                self.run_item_repository.create(
                    {
                        "run_id": run_id,
                        "case_id": case["id"],
                        "item_type": "api_case",
                        "status": "pending",
                        "retry_count": 0,
                        "request_data": {"case_version": case.get("version")},
                    }
                )
                for case in active_cases
            ]

        if run_type == "agent_eval":
            dataset_items = self.dataset_item_repository.list({"dataset_id": dataset_id}) if dataset_id is not None else []
            active_items = [item for item in dataset_items if item.get("status") != "archived"]
            return [
                self.run_item_repository.create(
                    {
                        "run_id": run_id,
                        "case_id": item.get("case_id"),
                        "dataset_item_id": item["id"],
                        "item_type": "dataset_case",
                        "status": "pending",
                        "retry_count": 0,
                        "request_data": {"dataset_item_id": item["id"]},
                    }
                )
                for item in active_items
            ]

        return []

    @staticmethod
    def _dispatch_run_items(run_items: list[dict]) -> None:
        dispatch_mode = os.getenv("RUN_DISPATCH_MODE", "background").strip().lower()
        if dispatch_mode == "inline":
            RunService._dispatch_run_items_inline(run_items)
            return

        if dispatch_mode == "async":
            for run_item in run_items:
                run_item_id = int(run_item["id"])
                execute_run_item.delay(run_item_id)
            return

        # Default behavior: return API response quickly and execute items in-process.
        # This avoids blocking run creation requests when local worker infra is absent.
        run_id = int(run_items[0]["run_id"]) if run_items else 0
        worker = Thread(
            target=RunService._dispatch_run_items_inline,
            args=(run_items,),
            daemon=True,
            name=f"run-dispatch-{run_id}",
        )
        worker.start()

    @staticmethod
    def _dispatch_run_items_inline(run_items: list[dict]) -> None:
        for run_item in run_items:
            run_item_id = int(run_item["id"])
            try:
                run_callable = getattr(execute_run_item, "run", None)
                if callable(run_callable):
                    run_callable(run_item_id)
                else:
                    execute_run_item(run_item_id)
            except Exception:  # noqa: BLE001
                logger.exception("run item dispatch failed for run_item_id=%s", run_item_id)
