from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.application.project_service import NotFoundError
from app.application.run_service import RunService
from app.infrastructure.repositories.run_schedule_repository import RunScheduleRepository
from app.infrastructure.repositories.table_repository import TableRepository


ALLOWED_RUN_TYPES = {"api_test", "agent_eval"}
ALLOWED_STATUSES = {"active", "paused", "archived"}
ALLOWED_REPORT_CHANNEL_TYPES = {"feishu_app"}
ALLOWED_REPORT_SUMMARY_SCOPES = {"project", "suite"}
DEFAULT_DAILY_TIME = "09:00"
DEFAULT_SCHEDULER_TIMEZONE = "Asia/Shanghai"
DAILY_TIME_PATTERN = re.compile(r"^\d{2}:\d{2}$")


class RunScheduleService:
    def __init__(
        self,
        schedule_repository: RunScheduleRepository | None = None,
        project_repository: TableRepository | None = None,
        suite_repository: TableRepository | None = None,
        dataset_repository: TableRepository | None = None,
        environment_repository: TableRepository | None = None,
        user_asset_repository: TableRepository | None = None,
    ) -> None:
        self.schedule_repository = schedule_repository or RunScheduleRepository()
        self.project_repository = project_repository or TableRepository("project")
        self.suite_repository = suite_repository or TableRepository("suite")
        self.dataset_repository = dataset_repository or TableRepository("dataset")
        self.environment_repository = environment_repository or TableRepository("environment")
        self.user_asset_repository = user_asset_repository or TableRepository("user_asset")
        self.scheduler_timezone = self._resolve_scheduler_timezone()

    def list_schedules(
        self,
        *,
        project_id: int | None = None,
        suite_id: int | None = None,
        status: str | None = None,
        run_type: str | None = None,
    ) -> list[dict]:
        normalized_run_type = self._normalize_run_type(run_type) if run_type is not None else None
        return self.schedule_repository.list(
            project_id=project_id,
            suite_id=suite_id,
            status=status,
            run_type=normalized_run_type,
        )

    def get_schedule(self, schedule_id: int) -> dict:
        record = self.schedule_repository.get(schedule_id)
        if record is None or record.get("status") == "archived":
            raise NotFoundError(f"run schedule {schedule_id} not found")
        return record

    def create_schedule(self, payload: dict) -> dict:
        run_type = self._normalize_run_type(payload.get("run_type"))
        project_id = self._require_int(payload.get("project_id"), "project_id")
        suite_id = self._optional_int(payload.get("suite_id"))
        environment_id = self._require_int(payload.get("environment_id"), "environment_id")
        dataset_id = self._optional_int(payload.get("dataset_id"))
        status = str(payload.get("status") or "active")
        if status not in {"active", "paused"}:
            raise ValueError("status must be active or paused")

        self._ensure_related_resources(
            project_id=project_id,
            suite_id=suite_id,
            environment_id=environment_id,
            dataset_id=dataset_id,
            run_type=run_type,
        )

        next_run_at = self._coerce_datetime(payload.get("next_run_at"))
        daily_time = self._normalize_daily_time(payload.get("daily_time"))
        if daily_time is None and next_run_at is not None:
            daily_time = self._daily_time_from_datetime(next_run_at)
        if daily_time is None:
            daily_time = DEFAULT_DAILY_TIME
        if next_run_at is None:
            next_run_at = self._next_run_at_from_daily_time(daily_time, self._utc_now())

        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("name is required")

        report_delivery = self._normalize_report_delivery(payload.get("report_delivery"), suite_id=suite_id)
        meta_info = payload.get("meta_info") if isinstance(payload.get("meta_info"), dict) else {}
        rule_ids = self._sanitize_rule_ids(payload.get("rule_ids"))
        record = {
            "name": name,
            "run_type": run_type,
            "project_id": project_id,
            "suite_id": suite_id,
            "environment_id": environment_id,
            "dataset_id": dataset_id if run_type == "agent_eval" else None,
            "daily_time": daily_time,
            "rule_ids": rule_ids,
            "evaluation_mode": str(payload.get("evaluation_mode") or "with_reference"),
            "next_run_at": next_run_at,
            "last_run_at": None,
            "last_run_id": None,
            "trigger_count": 0,
            "meta_info": {
                **meta_info,
                "report_delivery": report_delivery,
            },
            "status": status,
            "created_by": self._optional_int(payload.get("created_by")),
            "updated_by": self._optional_int(payload.get("updated_by")),
        }

        reusable_schedule = self._find_reusable_schedule(
            run_type=run_type,
            project_id=project_id,
            suite_id=suite_id,
            environment_id=environment_id,
            dataset_id=dataset_id if run_type == "agent_eval" else None,
            daily_time=daily_time,
        )
        if reusable_schedule is not None:
            reusable_id = int(reusable_schedule["id"])
            updated = self.schedule_repository.update(
                reusable_id,
                {
                    "name": record["name"],
                    "daily_time": record["daily_time"],
                    "rule_ids": record["rule_ids"],
                    "evaluation_mode": record["evaluation_mode"],
                    "next_run_at": record["next_run_at"],
                    "meta_info": record["meta_info"],
                    "status": record["status"],
                    "updated_by": record["updated_by"] if record["updated_by"] is not None else record["created_by"],
                },
            )
            if updated is not None:
                return updated
        return self.schedule_repository.create(record)

    def update_schedule(self, schedule_id: int, payload: dict) -> dict:
        existing = self.get_schedule(schedule_id)
        updates = dict(payload)
        if "run_type" in updates:
            updates["run_type"] = self._normalize_run_type(updates.get("run_type"))
        if "status" in updates:
            status = str(updates["status"])
            if status not in ALLOWED_STATUSES:
                raise ValueError("status must be active, paused or archived")
            updates["status"] = status
        if "daily_time" in updates:
            normalized_daily_time = self._normalize_daily_time(updates.get("daily_time"))
            if normalized_daily_time is None:
                raise ValueError("daily_time is required")
            updates["daily_time"] = normalized_daily_time
        if "rule_ids" in updates:
            updates["rule_ids"] = self._sanitize_rule_ids(updates.get("rule_ids"))
        if "next_run_at" in updates:
            updates["next_run_at"] = self._coerce_datetime(updates.get("next_run_at"))

        merged_run_type = str(updates.get("run_type") or existing.get("run_type"))
        merged_project_id = self._require_int(updates.get("project_id", existing.get("project_id")), "project_id")
        merged_suite_id = self._optional_int(updates.get("suite_id", existing.get("suite_id")))
        merged_environment_id = self._require_int(
            updates.get("environment_id", existing.get("environment_id")),
            "environment_id",
        )
        merged_dataset_id = self._optional_int(updates.get("dataset_id", existing.get("dataset_id")))
        self._ensure_related_resources(
            project_id=merged_project_id,
            suite_id=merged_suite_id,
            environment_id=merged_environment_id,
            dataset_id=merged_dataset_id,
            run_type=merged_run_type,
        )

        if merged_run_type == "api_test":
            updates["dataset_id"] = None

        if "name" in updates:
            name = str(updates.get("name") or "").strip()
            if not name:
                raise ValueError("name is required")
            updates["name"] = name

        existing_meta = existing.get("meta_info") if isinstance(existing.get("meta_info"), dict) else {}
        payload_meta = updates.get("meta_info") if isinstance(updates.get("meta_info"), dict) else {}
        if "report_delivery" in updates or "project_id" in updates or "meta_info" in updates:
            current_report_delivery = updates.get("report_delivery")
            if "report_delivery" not in updates:
                current_report_delivery = existing_meta.get("report_delivery")
            normalized_report_delivery = self._normalize_report_delivery(current_report_delivery, suite_id=merged_suite_id)
            updates["meta_info"] = {
                **existing_meta,
                **payload_meta,
                "report_delivery": normalized_report_delivery,
            }
        updates.pop("report_delivery", None)

        should_recompute_next_run = (
            ("daily_time" in updates and "next_run_at" not in updates)
            or ("status" in updates and updates.get("status") == "active" and "next_run_at" not in updates)
        )
        if should_recompute_next_run:
            merged_schedule = {**existing, **updates}
            updates["next_run_at"] = self._next_run_at(merged_schedule, self._utc_now())

        updated = self.schedule_repository.update(schedule_id, updates)
        if updated is None:
            raise NotFoundError(f"run schedule {schedule_id} not found")
        return updated

    def set_status(self, schedule_id: int, status: str) -> dict:
        existing = self.get_schedule(schedule_id)
        normalized = str(status).strip()
        if normalized not in {"active", "paused"}:
            raise ValueError("status must be active or paused")
        updates: dict[str, object] = {"status": normalized}
        if normalized == "active":
            updates["next_run_at"] = self._next_run_at(existing, self._utc_now())
        updated = self.schedule_repository.update(schedule_id, updates)
        if updated is None:
            raise NotFoundError(f"run schedule {schedule_id} not found")
        return updated

    def delete_schedule(self, schedule_id: int) -> dict:
        archived = self.schedule_repository.archive(schedule_id)
        if archived is None:
            raise NotFoundError(f"run schedule {schedule_id} not found")
        return {}

    def trigger_schedule(self, schedule_id: int, *, trigger_type: str = "manual") -> dict:
        schedule = self.get_schedule(schedule_id)
        run = self._create_run_from_schedule(schedule, trigger_type=trigger_type)
        now = self._utc_now()
        updates: dict[str, object] = {
            "last_run_at": now,
            "last_run_id": run["id"],
            "trigger_count": int(schedule.get("trigger_count") or 0) + 1,
        }
        if schedule.get("status") == "active":
            current_next = self._coerce_datetime(schedule.get("next_run_at"))
            if current_next is None or current_next <= now:
                updates["next_run_at"] = self._next_run_at(schedule, now)
        updated = self.schedule_repository.update(schedule_id, updates) or schedule
        return {"schedule": updated, "run": run}

    def dispatch_due_schedules(self, *, now: datetime | None = None, limit: int = 20) -> list[dict]:
        current = now.astimezone(timezone.utc) if now is not None else self._utc_now()
        due_schedules = self.schedule_repository.list_due(now=current, limit=limit)
        dispatch_results: list[dict] = []
        for schedule in due_schedules:
            schedule_id = int(schedule["id"])
            due_at = self._coerce_datetime(schedule.get("next_run_at"))
            if due_at is None:
                continue
            claimed = self.schedule_repository.claim_due(
                schedule_id,
                expected_next_run_at=due_at,
                now=current,
                next_run_at=self._next_run_at(schedule, current),
            )
            if not claimed:
                continue
            try:
                run = self._create_run_from_schedule(schedule, trigger_type="scheduled", scheduled_for=due_at)
                self.schedule_repository.update(
                    schedule_id,
                    {
                        "last_run_id": run["id"],
                    },
                )
                dispatch_results.append(
                    {
                        "schedule_id": schedule_id,
                        "run_id": int(run["id"]),
                        "status": "triggered",
                    }
                )
            except Exception as exc:  # noqa: BLE001
                existing_meta = schedule.get("meta_info") if isinstance(schedule.get("meta_info"), dict) else {}
                next_meta = {
                    **existing_meta,
                    "last_error": str(exc),
                    "last_error_at": current.isoformat(),
                }
                self.schedule_repository.update(
                    schedule_id,
                    {
                        "meta_info": next_meta,
                    },
                )
                dispatch_results.append(
                    {
                        "schedule_id": schedule_id,
                        "status": "failed",
                        "error": str(exc),
                    }
                )
        return dispatch_results

    def _create_run_from_schedule(
        self,
        schedule: dict,
        *,
        trigger_type: str,
        scheduled_for: datetime | None = None,
    ) -> dict:
        run_type = str(schedule.get("run_type") or "")
        suite_id = self._optional_int(schedule.get("suite_id"))
        payload = {
            "run_type": run_type,
            "project_id": int(schedule["project_id"]),
            "suite_id": suite_id,
            "environment_id": int(schedule["environment_id"]),
            "dataset_id": int(schedule["dataset_id"]) if schedule.get("dataset_id") is not None else None,
            "rule_ids": self._sanitize_rule_ids(schedule.get("rule_ids")),
            "evaluation_mode": str(schedule.get("evaluation_mode") or "with_reference"),
            "trigger_type": trigger_type,
            "source_id": int(schedule["id"]),
        }
        if run_type == "api_test":
            payload["dataset_id"] = None
        idempotency_key = self._build_schedule_idempotency_key(
            schedule_id=int(schedule["id"]),
            trigger_type=trigger_type,
            scheduled_for=scheduled_for,
        )
        return RunService().create_run(payload, idempotency_key)

    @staticmethod
    def _build_schedule_idempotency_key(
        *,
        schedule_id: int,
        trigger_type: str,
        scheduled_for: datetime | None,
    ) -> str:
        if trigger_type == "scheduled" and scheduled_for is not None:
            slot_utc = scheduled_for.astimezone(timezone.utc).replace(microsecond=0)
            slot_token = slot_utc.strftime("%Y%m%dT%H%M%SZ")
            return f"run-schedule-{schedule_id}-{slot_token}"
        return f"run-schedule-{schedule_id}-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid4().hex[:8]}"

    def _ensure_related_resources(
        self,
        *,
        project_id: int,
        suite_id: int | None,
        environment_id: int,
        dataset_id: int | None,
        run_type: str,
    ) -> None:
        project = self.project_repository.get(project_id)
        if project is None:
            raise NotFoundError(f"project {project_id} not found")

        if suite_id is not None:
            suite = self.suite_repository.get(suite_id)
            if suite is None:
                raise NotFoundError(f"suite {suite_id} not found")
            if suite["project_id"] != project_id:
                raise ValueError("suite does not belong to project")

        environment = self.environment_repository.get(environment_id)
        if environment is None:
            raise NotFoundError(f"environment {environment_id} not found")
        if environment["project_id"] != project_id:
            raise ValueError("environment does not belong to project")

        if run_type == "agent_eval":
            if dataset_id is None:
                raise ValueError("dataset_id is required for benchmark schedules")
            dataset = self.dataset_repository.get(dataset_id)
            if dataset is None:
                raise NotFoundError(f"dataset {dataset_id} not found")
            if dataset["project_id"] != project_id:
                raise ValueError("dataset does not belong to project")
        elif dataset_id is not None:
            dataset = self.dataset_repository.get(dataset_id)
            if dataset is None:
                raise NotFoundError(f"dataset {dataset_id} not found")
            if dataset["project_id"] != project_id:
                raise ValueError("dataset does not belong to project")

    def _find_reusable_schedule(
        self,
        *,
        run_type: str,
        project_id: int,
        suite_id: int | None,
        environment_id: int,
        dataset_id: int | None,
        daily_time: str,
    ) -> dict | None:
        candidates = self.schedule_repository.list(project_id=project_id, suite_id=suite_id, run_type=run_type)
        ordered_candidates = sorted(candidates, key=lambda item: int(item.get("id") or 0), reverse=True)
        for candidate in ordered_candidates:
            if str(candidate.get("status") or "") not in {"active", "paused"}:
                continue
            candidate_suite_id = self._optional_int(candidate.get("suite_id"))
            if candidate_suite_id != suite_id:
                continue
            candidate_environment_id = self._optional_int(candidate.get("environment_id"))
            if candidate_environment_id != environment_id:
                continue
            candidate_dataset_id = self._optional_int(candidate.get("dataset_id"))
            if candidate_dataset_id != dataset_id:
                continue
            try:
                candidate_daily_time = self._normalize_daily_time(candidate.get("daily_time")) or DEFAULT_DAILY_TIME
            except ValueError:
                continue
            if candidate_daily_time != daily_time:
                continue
            return candidate
        return None

    @staticmethod
    def _normalize_run_type(value: object) -> str:
        normalized = str(value or "").strip()
        if normalized == "benchmark":
            normalized = "agent_eval"
        if normalized not in ALLOWED_RUN_TYPES:
            raise ValueError("run_type must be api_test or benchmark")
        return normalized

    @staticmethod
    def _sanitize_rule_ids(value: object) -> list[int]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("rule_ids must be an array")
        next_ids = sorted({int(item) for item in value if isinstance(item, int) and item > 0})
        return next_ids

    def _normalize_report_delivery(self, value: object, *, suite_id: int | None) -> dict:
        default_scope = "suite" if suite_id is not None else "project"
        if not isinstance(value, dict):
            return {
                "enabled": False,
                "channel_asset_id": None,
                "custom_channel": None,
                "message": None,
                "summary_scope": default_scope,
                "include_report_page_screenshot": True,
            }

        enabled_input = bool(value.get("enabled"))
        channel_asset_id = self._optional_int(value.get("channel_asset_id", value.get("channelAssetId")))
        message_raw = value.get("message")
        message = str(message_raw).strip() if isinstance(message_raw, str) else ""
        normalized_message = message[:500] if message else None
        summary_scope_raw = value.get("summary_scope", value.get("summaryScope"))
        summary_scope = str(summary_scope_raw).strip().lower() if isinstance(summary_scope_raw, str) else default_scope
        if summary_scope not in ALLOWED_REPORT_SUMMARY_SCOPES:
            summary_scope = default_scope
        if summary_scope == "suite" and suite_id is None:
            raise ValueError("summary_scope set to suite requires schedule suite_id")

        include_screenshot_raw = value.get(
            "include_report_page_screenshot",
            value.get("includeReportPageScreenshot"),
        )
        include_report_page_screenshot = True if include_screenshot_raw is None else bool(include_screenshot_raw)

        if channel_asset_id is not None:
            self._validate_report_channel_asset(channel_asset_id)

        enabled = enabled_input and channel_asset_id is not None

        return {
            "enabled": enabled,
            "channel_asset_id": channel_asset_id,
            "custom_channel": None,
            "message": normalized_message,
            "summary_scope": summary_scope,
            "include_report_page_screenshot": include_report_page_screenshot,
        }

    def _validate_report_channel_asset(self, channel_asset_id: int) -> None:
        asset = self.user_asset_repository.get(channel_asset_id)
        if asset is None:
            raise NotFoundError(f"report channel asset {channel_asset_id} not found")
        if str(asset.get("asset_type") or "") != "report_channel":
            raise ValueError("report channel asset_type must be report_channel")
        if str(asset.get("status") or "active") != "active":
            raise ValueError("report channel must be active")
        content_json = asset.get("content_json") if isinstance(asset.get("content_json"), dict) else {}
        channel_type = str(content_json.get("channel_type") or "").strip() or "feishu_app"
        if channel_type not in ALLOWED_REPORT_CHANNEL_TYPES:
            raise ValueError("report channel_type currently only supports feishu_app")
        self._validate_feishu_app_channel(content_json)

    @staticmethod
    def _validate_feishu_app_channel(content_json: dict[str, object]) -> None:
        app_id = str(content_json.get("app_id") or "").strip()
        app_secret = str(content_json.get("app_secret") or "").strip()
        chat_id = str(content_json.get("chat_id") or "").strip()
        if not app_id:
            raise ValueError("report channel app_id is required")
        if not app_secret:
            raise ValueError("report channel app_secret is required")
        if not chat_id:
            raise ValueError("report channel chat_id is required")

    def _next_run_at(self, schedule: dict, now: datetime) -> datetime:
        daily_time = self._normalize_daily_time(schedule.get("daily_time")) or DEFAULT_DAILY_TIME
        return self._next_run_at_from_daily_time(daily_time, now)

    @staticmethod
    def _coerce_datetime(value: object) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc)
            return value.astimezone(timezone.utc)
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return None
            normalized = raw.replace("Z", "+00:00")
            try:
                parsed = datetime.fromisoformat(normalized)
            except ValueError as exc:
                raise ValueError("next_run_at must be ISO datetime") from exc
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        raise ValueError("next_run_at must be datetime")

    @staticmethod
    def _require_int(value: object, field_name: str) -> int:
        if not isinstance(value, int):
            raise ValueError(f"{field_name} is required")
        return int(value)

    @staticmethod
    def _optional_int(value: object) -> int | None:
        return int(value) if isinstance(value, int) else None

    @staticmethod
    def _normalize_daily_time(value: object) -> str | None:
        if value is None:
            return None
        raw = str(value).strip()
        if not raw:
            return None
        if not DAILY_TIME_PATTERN.match(raw):
            raise ValueError("daily_time must be in HH:mm format")
        hour = int(raw[0:2])
        minute = int(raw[3:5])
        if hour > 23 or minute > 59:
            raise ValueError("daily_time must be in HH:mm format")
        return f"{hour:02d}:{minute:02d}"

    def _daily_time_from_datetime(self, value: datetime) -> str:
        local_value = value.astimezone(self.scheduler_timezone)
        return local_value.strftime("%H:%M")

    def _next_run_at_from_daily_time(self, daily_time: str, now: datetime) -> datetime:
        hour = int(daily_time[0:2])
        minute = int(daily_time[3:5])
        now_utc = now.astimezone(timezone.utc)
        now_local = now_utc.astimezone(self.scheduler_timezone)
        target_local = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target_local <= now_local:
            target_local = target_local + timedelta(days=1)
        return target_local.astimezone(timezone.utc)

    @staticmethod
    def _resolve_scheduler_timezone() -> ZoneInfo:
        timezone_name = os.getenv("RUN_SCHEDULER_TIMEZONE", DEFAULT_SCHEDULER_TIMEZONE).strip() or DEFAULT_SCHEDULER_TIMEZONE
        try:
            return ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError:
            return ZoneInfo("UTC")

    @staticmethod
    def _utc_now() -> datetime:
        return datetime.now(timezone.utc)
