from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from app.application.evaluation_service import EvaluationService
from app.application.report_delivery_service import ReportDeliveryService
from app.domain.runners.agent_executor_adapter import AgentExecutorAdapter
from app.domain.runners.pytest_runner_adapter import PytestRunnerAdapter
from app.infrastructure.mq.celery_app import celery_app
from app.infrastructure.repositories.run_repository import RunRepository
from app.infrastructure.repositories.table_repository import TableRepository

logger = logging.getLogger(__name__)


@celery_app.task(name="execution.execute_run_item")
def execute_run_item(run_item_id: int):
    run_item_repository = TableRepository("run_item")
    run_log_repository = TableRepository("run_log")
    run_item = run_item_repository.get(run_item_id)
    if run_item is None:
        return {"run_item_id": run_item_id, "status": "missing"}

    run_record = RunRepository().get(run_item["run_id"])
    if _is_run_stopped(run_record):
        finished_at = datetime.now(timezone.utc)
        run_item_repository.update(run_item_id, {"status": "canceled", "finished_at": finished_at})
        _update_run_summary(run_item["run_id"])
        return {"run_item_id": run_item_id, "status": "canceled"}

    started_at = datetime.now(timezone.utc)
    run_item_repository.update(run_item_id, {"status": "running", "started_at": started_at})

    run_item = run_item_repository.get(run_item_id) or run_item
    run_record = RunRepository().get(run_item["run_id"])
    case_item = TableRepository("case_item").get(run_item["case_id"]) if run_item.get("case_id") else None
    dataset_item = TableRepository("dataset_item").get(run_item["dataset_item_id"]) if run_item.get("dataset_item_id") else None
    environment = None
    if run_record and run_record.get("environment_id"):
        environment = TableRepository("environment").get(run_record["environment_id"])

    if _is_run_stopped(run_record):
        finished_at = datetime.now(timezone.utc)
        run_item_repository.update(run_item_id, {"status": "canceled", "finished_at": finished_at})
        _update_run_summary(run_item["run_id"])
        return {"run_item_id": run_item_id, "status": "canceled"}

    if run_record and run_record.get("status") in {"pending", "queued"}:
        RunRepository().update(run_record["id"], {"status": "running", "started_at": started_at})

    if run_record is not None:
        _append_run_log(
            run_log_repository,
            run_id=run_record["id"],
            run_item_id=run_item_id,
            log_level="INFO",
            log_type="execution",
            content=f"run_item#{run_item_id} started ({run_item.get('item_type')})",
            meta_info={
                "case_id": run_item.get("case_id"),
                "dataset_item_id": run_item.get("dataset_item_id"),
            },
        )

    if not run_record or not case_item:
        finished_at = datetime.now(timezone.utc)
        run_item_repository.update(
            run_item_id,
            {
                "status": "failed",
                "error_info": {"message": "unsupported run item"},
                "finished_at": finished_at,
            },
        )
        if run_record is not None:
            _append_run_log(
                run_log_repository,
                run_id=run_record["id"],
                run_item_id=run_item_id,
                log_level="ERROR",
                log_type="system",
                content="run item execution failed: unsupported run item",
                meta_info={"has_case_item": bool(case_item), "has_run_record": bool(run_record)},
            )
        return {"run_item_id": run_item_id, "status": "failed"}

    try:
        run_record = RunRepository().get(run_item["run_id"])
        if _is_run_stopped(run_record):
            finished_at = datetime.now(timezone.utc)
            run_item_repository.update(run_item_id, {"status": "canceled", "finished_at": finished_at})
            _update_run_summary(run_item["run_id"])
            return {"run_item_id": run_item_id, "status": "canceled"}

        if run_item.get("item_type") == "api_case":
            input_payload = case_item.get("input_payload") if isinstance(case_item.get("input_payload"), dict) else {}
            _append_run_log(
                run_log_repository,
                run_id=run_record["id"],
                run_item_id=run_item_id,
                log_level="INFO",
                log_type="execution",
                content=f"API request dispatch {input_payload.get('method', 'GET')} {input_payload.get('path', '-')}",
                meta_info={"case_id": case_item.get("id")},
            )
            request_snapshot = run_record.get("request_snapshot") or {}
            bound_rules = request_snapshot.get("bound_rules") if isinstance(request_snapshot, dict) else []
            attempt_records: list[dict[str, Any]] = []

            def _on_api_attempt(progress: dict[str, Any]) -> None:
                if not isinstance(progress, dict):
                    return
                attempt = int(progress.get("attempt") or 0)
                attempt_record = {
                    "attempt": attempt,
                    "status_code": progress.get("status_code"),
                    "assertion_passed": bool(progress.get("assertion_passed")),
                    "error_type": progress.get("error_type"),
                    "checks": progress.get("check_results") if isinstance(progress.get("check_results"), list) else [],
                }
                attempt_records.append(attempt_record)

                latest_request_data = {
                    **(run_item.get("request_data") or {}),
                    "method": input_payload.get("method"),
                    "path": input_payload.get("path"),
                    "retry_count": progress.get("retry_count"),
                    "retry_interval_seconds": progress.get("retry_interval_seconds"),
                    "timeout_seconds": progress.get("timeout_seconds"),
                    "attempt_count": attempt,
                    "attempts": list(attempt_records),
                }
                latest_response_data = {
                    "url": progress.get("request_url"),
                    "status_code": progress.get("status_code"),
                    "json": progress.get("response_json"),
                }
                run_item_repository.update(
                    run_item_id,
                    {
                        "status": "running",
                        "request_data": latest_request_data,
                        "response_data": latest_response_data,
                    },
                )
                _update_run_summary(run_record["id"])

            result = PytestRunnerAdapter().execute_api_case(
                run_record=run_record,
                run_item=run_item,
                case_item=case_item,
                environment=environment,
                bound_rules=bound_rules if isinstance(bound_rules, list) else [],
                on_attempt=_on_api_attempt,
            )
        elif run_item.get("item_type") == "dataset_case" and dataset_item is not None:
            _append_run_log(
                run_log_repository,
                run_id=run_record["id"],
                run_item_id=run_item_id,
                log_level="INFO",
                log_type="execution",
                content="Benchmark evaluation started",
                meta_info={"case_id": case_item.get("id"), "dataset_item_id": dataset_item.get("id")},
            )
            result = _execute_agent_eval_case(
                run_record=run_record,
                run_item=run_item,
                case_item=case_item,
                dataset_item=dataset_item,
                environment=environment,
                run_log_repository=run_log_repository,
            )
        else:
            finished_at = datetime.now(timezone.utc)
            run_item_repository.update(
                run_item_id,
                {
                    "status": "failed",
                    "error_info": {"message": "unsupported run item"},
                    "finished_at": finished_at,
                },
            )
            _append_run_log(
                run_log_repository,
                run_id=run_record["id"],
                run_item_id=run_item_id,
                log_level="ERROR",
                log_type="system",
                content="run item execution failed: unsupported run item type",
                meta_info={"item_type": run_item.get("item_type")},
            )
            _update_run_summary(run_record["id"])
            return {"run_item_id": run_item_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        finished_at = datetime.now(timezone.utc)
        run_item_repository.update(
            run_item_id,
            {
                "status": "failed",
                "error_info": {"type": "execution_error", "message": str(exc)},
                "finished_at": finished_at,
            },
        )
        _append_run_log(
            run_log_repository,
            run_id=run_record["id"],
            run_item_id=run_item_id,
            log_level="ERROR",
            log_type="system",
            content="run item execution failed with exception",
            meta_info={"item_type": run_item.get("item_type"), "error": str(exc)},
        )
        _update_run_summary(run_record["id"])
        return {"run_item_id": run_item_id, "status": "failed"}

    run_record = RunRepository().get(run_item["run_id"])
    if _is_run_stopped(run_record):
        finished_at = datetime.now(timezone.utc)
        run_item_repository.update(run_item_id, {"status": "canceled", "finished_at": finished_at})
        _update_run_summary(run_item["run_id"])
        return {"run_item_id": run_item_id, "status": "canceled"}

    execution_finished_at = datetime.now(timezone.utc)
    result.setdefault("started_at", started_at)
    result.setdefault("finished_at", execution_finished_at)
    if result.get("duration_ms") is None:
        result["duration_ms"] = max(1, int((execution_finished_at - started_at).total_seconds() * 1000))

    updated_run_item = run_item_repository.update(run_item_id, result)
    _append_run_log(
        run_log_repository,
        run_id=run_record["id"],
        run_item_id=run_item_id,
        log_level="INFO" if updated_run_item["status"] == "success" else "ERROR",
        log_type="assertion" if run_item.get("item_type") == "api_case" else "judge",
        content=f"run_item#{run_item_id} finished with status={updated_run_item['status']}",
        meta_info={
            "assertion_passed": (updated_run_item.get("assertion_result") or {}).get("passed"),
            "total_score": (updated_run_item.get("score_result") or {}).get("total_score"),
        },
    )
    _update_run_summary(run_record["id"])
    return {"run_item_id": run_item_id, "status": updated_run_item["status"]}


def _execute_agent_eval_case(
    *,
    run_record: dict,
    run_item: dict,
    case_item: dict,
    dataset_item: dict,
    environment: dict | None,
    run_log_repository: TableRepository,
) -> dict:
    benchmark_api_case = _resolve_benchmark_api_case(case_item=case_item, dataset_item=dataset_item)
    use_api_execution = benchmark_api_case is not None
    _append_run_log(
        run_log_repository,
        run_id=run_record["id"],
        run_item_id=run_item.get("id"),
        log_level="INFO",
        log_type="execution",
        content="Benchmark execution mode resolved",
        meta_info={
            "use_api_execution": use_api_execution,
            "dataset_case_id": case_item.get("id"),
            "resolved_api_case_id": benchmark_api_case.get("id") if isinstance(benchmark_api_case, dict) else None,
        },
    )

    if use_api_execution and benchmark_api_case is not None:
        benchmark_input = benchmark_api_case.get("input_payload") if isinstance(benchmark_api_case.get("input_payload"), dict) else {}
        _append_run_log(
            run_log_repository,
            run_id=run_record["id"],
            run_item_id=run_item.get("id"),
            log_level="INFO",
            log_type="execution",
            content="Benchmark API execution dispatch",
            meta_info={
                "method": benchmark_input.get("method"),
                "path": benchmark_input.get("path"),
                "api_case_id": benchmark_api_case.get("id"),
            },
        )
        case_for_benchmark = {
            **benchmark_api_case,
            "expected_output": {},
            "assertion_config": {},
        }
        api_result = PytestRunnerAdapter().execute_api_case(
            run_record=run_record,
            run_item=run_item,
            case_item=case_for_benchmark,
            environment=environment,
            bound_rules=[],
        )
        adapter_result = {
            "status": "success" if api_result.get("error_info") is None else "failed",
            "request_data": {
                **(api_result.get("request_data") or {}),
                "benchmark_agent_case_id": case_item.get("id"),
                "benchmark_api_case_id": benchmark_api_case.get("id"),
                "benchmark_api_request_case": benchmark_input,
            },
            "response_data": api_result.get("response_data") or {},
            "parsed_output": _extract_benchmark_output_from_api_response(api_result.get("response_data") or {}),
            "error_info": api_result.get("error_info"),
        }
    else:
        adapter_result = AgentExecutorAdapter().execute(
            case_item=case_item,
            dataset_item=dataset_item,
            environment=environment,
        )

    if adapter_result.get("status") == "failed":
        now = datetime.now(timezone.utc)
        return {
            "request_data": {
                **(run_item.get("request_data") or {}),
                **(adapter_result.get("request_data") or {}),
                "bound_rule_ids": _bound_rule_ids(run_record),
                "execution_mode": "api_case" if use_api_execution else "agent",
            },
            "response_data": adapter_result.get("response_data"),
            "parsed_output": adapter_result.get("parsed_output"),
            "error_info": adapter_result.get("error_info") or {"type": "agent_execution_error", "message": "agent execution failed"},
            "status": "failed",
            "started_at": now,
            "finished_at": now,
        }

    expected = dataset_item.get("reference_answer") or case_item.get("expected_output") or {}
    eval_config = _build_eval_config_from_bound_rules(run_record) or {}
    if not eval_config.get("evaluators"):
        eval_config = case_item.get("eval_config") if isinstance(case_item.get("eval_config"), dict) else {}
    if not eval_config.get("evaluators"):
        eval_config = {
            "threshold": 0.8,
            "evaluators": [
                {
                    "type": "llm_judge",
                    "weight": 1.0,
                    "model": "kimi",
                    "dimensions": [
                        {"name": "correctness", "weight": 0.5},
                        {"name": "relevance", "weight": 0.3},
                        {"name": "completeness", "weight": 0.2},
                    ],
                }
            ],
        }

    try:
        evaluation_result = EvaluationService().evaluate_with_trace(
            case_or_item={
                "run_id": run_record["id"],
                "run_item_id": run_item["id"],
                "case_id": case_item["id"],
                "dataset_item_id": dataset_item["id"],
                "project_id": case_item.get("project_id"),
            },
            output=adapter_result["parsed_output"],
            expected=expected,
            evaluator_config=eval_config,
        )
        _persist_judge_records(
            run_item_id=run_item["id"],
            traces=evaluation_result["evaluator_traces"],
            output=adapter_result["parsed_output"],
            expected=expected,
        )
    except Exception as exc:  # noqa: BLE001
        now = datetime.now(timezone.utc)
        return {
            "request_data": {
                **(run_item.get("request_data") or {}),
                **(adapter_result.get("request_data") or {}),
                "bound_rule_ids": _bound_rule_ids(run_record),
                "execution_mode": "api_case" if use_api_execution else "agent",
            },
            "response_data": adapter_result.get("response_data"),
            "parsed_output": adapter_result.get("parsed_output"),
            "error_info": {"type": "evaluation_error", "message": str(exc)},
            "status": "failed",
            "started_at": now,
            "finished_at": now,
        }

    now = datetime.now(timezone.utc)
    return {
        "request_data": {
            **(run_item.get("request_data") or {}),
            **(adapter_result.get("request_data") or {}),
            "bound_rule_ids": _bound_rule_ids(run_record),
            "execution_mode": "api_case" if use_api_execution else "agent",
        },
        "response_data": adapter_result.get("response_data"),
        "parsed_output": adapter_result.get("parsed_output"),
        "score_result": evaluation_result["score_result"],
        "status": "success" if evaluation_result["score_result"]["passed"] else "failed",
        "started_at": now,
        "finished_at": now,
    }


def _resolve_benchmark_api_case(
    *,
    case_item: dict[str, Any],
    dataset_item: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if _is_api_case_payload(case_item):
        return case_item

    case_meta = case_item.get("meta_info") if isinstance(case_item.get("meta_info"), dict) else {}
    current_case_id = case_item.get("id")
    if not isinstance(current_case_id, int):
        return None

    case_repository = TableRepository("case_item")
    candidates = case_repository.list({"suite_id": case_item.get("suite_id")})
    linked_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        if not _is_api_case_payload(candidate):
            continue
        candidate_meta = candidate.get("meta_info") if isinstance(candidate.get("meta_info"), dict) else {}
        linked_id = candidate_meta.get("linked_agent_case_id")
        if isinstance(linked_id, int) and linked_id == current_case_id:
            linked_candidates.append(candidate)

    generation_batch_id = _extract_generation_batch_id(dataset_item) or _extract_generation_batch_id(case_item)
    if generation_batch_id is not None:
        batch_candidates = [
            candidate
            for candidate in linked_candidates
            if _extract_generation_batch_id(candidate) == generation_batch_id
        ]
        if batch_candidates:
            linked_candidates = batch_candidates

    if linked_candidates:
        linked_candidates.sort(
            key=lambda candidate: (
                _extract_generation_index(candidate),
                int(candidate.get("id") or 0),
            )
        )
        return linked_candidates[0]

    linked_api_case_id = case_meta.get("linked_api_case_id")
    if isinstance(linked_api_case_id, int):
        linked_case = case_repository.get(linked_api_case_id)
        if isinstance(linked_case, dict) and _is_api_case_payload(linked_case):
            return linked_case

    return None


def _extract_generation_batch_id(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("generation_batch_id"), str):
        value = payload.get("generation_batch_id", "").strip()
        if value:
            return value
    meta_info = payload.get("meta_info")
    if isinstance(meta_info, dict) and isinstance(meta_info.get("generation_batch_id"), str):
        value = str(meta_info.get("generation_batch_id")).strip()
        if value:
            return value
    return None


def _extract_generation_index(case_item: dict[str, Any]) -> int:
    meta_info = case_item.get("meta_info") if isinstance(case_item.get("meta_info"), dict) else {}
    raw = meta_info.get("generation_index")
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float) and raw.is_integer():
        return int(raw)
    if isinstance(raw, str) and raw.strip().isdigit():
        return int(raw.strip())
    return 10**9


def _is_api_case_payload(case_item: dict[str, Any]) -> bool:
    input_payload = case_item.get("input_payload")
    if not isinstance(input_payload, dict):
        return False
    method = input_payload.get("method")
    path = input_payload.get("path")
    return isinstance(method, str) and method.strip() != "" and isinstance(path, str) and path.strip() != ""


def _extract_benchmark_output_from_api_response(response_data: dict[str, Any]) -> Any:
    payload = response_data.get("json")
    if payload is not None:
        if isinstance(payload, dict):
            stream_events = payload.get("stream_events")
            if isinstance(stream_events, list):
                stream_text = _merge_stream_event_text(stream_events)
                if stream_text:
                    return stream_text

            data_node = payload.get("data")
            if isinstance(data_node, dict):
                text_candidate = data_node.get("text")
                if isinstance(text_candidate, str) and text_candidate.strip():
                    return text_candidate
                answer_candidate = data_node.get("answer")
                if isinstance(answer_candidate, str) and answer_candidate.strip():
                    return answer_candidate
            for key in ("output", "answer", "result", "text"):
                candidate = payload.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate
        return payload
    text_payload = response_data.get("text")
    if isinstance(text_payload, str):
        stream_text = _extract_text_from_sse_raw_payload(text_payload)
        if stream_text:
            return stream_text
        return text_payload
    return None


def _merge_stream_event_text(stream_events: list[Any]) -> str | None:
    parts: list[str] = []
    for event in stream_events:
        if not isinstance(event, dict):
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        text = data.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
    merged = "".join(parts).strip()
    return merged if merged else None


def _extract_text_from_sse_raw_payload(raw_text: str) -> str | None:
    parts: list[str] = []
    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload_text = line[5:].strip()
        if not payload_text or payload_text == "[DONE]":
            continue
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        data = payload.get("data")
        if not isinstance(data, dict):
            continue
        text = data.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
    merged = "".join(parts).strip()
    return merged if merged else None


def _persist_judge_records(*, run_item_id: int, traces: list[dict], output, expected) -> None:
    judge_record_repository = TableRepository("judge_record")
    for trace in traces:
        if trace.get("type") != "llm_judge":
            continue
        config = trace.get("config") or {}
        result = trace.get("result") or {}
        judge_record_repository.create(
            {
                "run_item_id": run_item_id,
                "evaluator_id": None,
                "prompt_snapshot": config.get("prompt_template", "Judge the output"),
                "input_snapshot": expected,
                "output_snapshot": output,
                "raw_response": result,
                "parsed_result": result.get("dimensions") or [],
                "model_name": result.get("model_name"),
                "model_version": result.get("model_version"),
                "token_usage": result.get("token_usage"),
                "latency_ms": result.get("latency_ms"),
            }
        )


def _build_eval_config_from_bound_rules(run_record: dict) -> dict[str, Any] | None:
    request_snapshot = run_record.get("request_snapshot") or {}
    if not isinstance(request_snapshot, dict):
        return None
    raw_bound_rules = request_snapshot.get("bound_rules")
    if not isinstance(raw_bound_rules, list):
        return None

    scoring_rule_contents: list[dict[str, Any]] = []
    for rule in raw_bound_rules:
        if not isinstance(rule, dict):
            continue
        if rule.get("rule_type") != "scoring":
            continue
        content = rule.get("content")
        if isinstance(content, dict):
            scoring_rule_contents.append(content)
    if not scoring_rule_contents:
        return None

    evaluators: list[dict[str, Any]] = []
    threshold_values: list[float] = []

    for scoring_rule in scoring_rule_contents:
        evaluator_type = scoring_rule.get("match_type")
        if evaluator_type not in {"exact_match", "json_match", "llm_judge", "rule_based"}:
            evaluator_type = "llm_judge"

        evaluator_weight = 1.0
        try:
            evaluator_weight = max(0.0, float(scoring_rule.get("rule_weight", 1.0)))
        except (TypeError, ValueError):
            evaluator_weight = 1.0
        if evaluator_weight <= 0:
            evaluator_weight = 1.0

        evaluator: dict[str, Any] = {
            "type": evaluator_type,
            "weight": evaluator_weight,
        }

        if evaluator_type == "llm_judge":
            judge_prompt = scoring_rule.get("judge_prompt")
            if isinstance(judge_prompt, str) and judge_prompt.strip():
                evaluator["prompt_template"] = judge_prompt.strip()
            if isinstance(scoring_rule.get("dimensions"), list):
                evaluator["dimensions"] = scoring_rule["dimensions"]
            if scoring_rule.get("rubric") is not None:
                evaluator["rubric"] = scoring_rule.get("rubric")
            for option_key in ("timeout_seconds", "max_retries", "retry_backoff_seconds"):
                option_value = scoring_rule.get(option_key)
                if isinstance(option_value, (int, float)):
                    evaluator[option_key] = option_value
        elif evaluator_type == "rule_based" and isinstance(scoring_rule.get("rules"), list):
            evaluator["rules"] = scoring_rule["rules"]

        evaluators.append(evaluator)

        threshold = scoring_rule.get("threshold", 0.8)
        try:
            threshold_values.append(max(0.0, min(1.0, float(threshold))))
        except (TypeError, ValueError):
            threshold_values.append(0.8)

    if not evaluators:
        return None

    threshold = 0.8
    if threshold_values:
        threshold = sum(threshold_values) / len(threshold_values)

    return {
        "threshold": round(threshold, 4),
        "evaluators": evaluators,
    }


def _bound_rule_ids(run_record: dict) -> list[int]:
    request_snapshot = run_record.get("request_snapshot") or {}
    if not isinstance(request_snapshot, dict):
        return []
    ids = request_snapshot.get("bound_rule_ids")
    if not isinstance(ids, list):
        return []
    result: list[int] = []
    for value in ids:
        if isinstance(value, int):
            result.append(value)
    return result


def _append_run_log(
    repository: TableRepository,
    *,
    run_id: int,
    run_item_id: int | None,
    log_level: str,
    log_type: str,
    content: str,
    meta_info: dict[str, Any] | None = None,
) -> None:
    repository.create(
        {
            "run_id": run_id,
            "run_item_id": run_item_id,
            "log_level": log_level,
            "log_type": log_type,
            "content": content,
            "meta_info": meta_info or {},
        }
    )


def _update_run_summary(run_id: int) -> None:
    run_record = RunRepository().get(run_id)
    if run_record is None:
        return

    run_item_repository = TableRepository("run_item")
    run_items = run_item_repository.list({"run_id": run_id})
    total = len(run_items)
    passed = sum(1 for item in run_items if item.get("status") == "success")
    failed = sum(1 for item in run_items if item.get("status") == "failed")
    canceled = sum(1 for item in run_items if item.get("status") == "canceled")
    running = any(item.get("status") in {"pending", "running", "retrying"} for item in run_items)

    if run_record.get("status") == "canceled" and not running:
        run_status = "canceled"
    elif running:
        run_status = "running"
    elif failed and passed:
        run_status = "partially_success"
    elif failed:
        run_status = "failed"
    elif canceled == total and total > 0:
        run_status = "canceled"
    else:
        run_status = "success"

    summary: dict[str, Any] = {"total": total, "passed": passed, "failed": failed, "canceled": canceled}

    run_type = run_record.get("run_type")
    if run_type == "agent_eval":
        scores: list[float] = []
        dimension_bucket: dict[str, list[float]] = {}
        for item in run_items:
            score_result = item.get("score_result")
            if not isinstance(score_result, dict):
                continue
            total_score = score_result.get("total_score")
            if isinstance(total_score, (int, float)):
                scores.append(float(total_score))
            dimensions = score_result.get("dimensions")
            if not isinstance(dimensions, list):
                continue
            for dimension in dimensions:
                if not isinstance(dimension, dict):
                    continue
                name = dimension.get("name")
                score = dimension.get("score")
                if isinstance(name, str) and isinstance(score, (int, float)):
                    dimension_bucket.setdefault(name, []).append(float(score))

        if scores:
            summary["avg_score"] = round(sum(scores) / len(scores), 4)
            summary["min_score"] = round(min(scores), 4)
            summary["max_score"] = round(max(scores), 4)
        else:
            summary["avg_score"] = 0.0
            summary["min_score"] = 0.0
            summary["max_score"] = 0.0

        summary["pass_rate"] = round((passed / total), 4) if total > 0 else 0.0
        summary["dimension_scores"] = [
            {
                "name": name,
                "score": round(sum(values) / len(values), 4),
                "count": len(values),
            }
            for name, values in sorted(dimension_bucket.items(), key=lambda item: item[0])
            if values
        ]

    updated_run = RunRepository().update(
        run_id,
        {
            "status": run_status,
            "summary": summary,
        },
    )
    if updated_run is None:
        return
    try:
        ReportDeliveryService().deliver_for_run(updated_run)
    except Exception as exc:  # noqa: BLE001
        logger.warning("report delivery failed for run #%s: %s", run_id, exc, exc_info=True)


def _is_run_stopped(run_record: dict[str, Any] | None) -> bool:
    if not isinstance(run_record, dict):
        return False
    return str(run_record.get("status") or "").strip().lower() in {"canceled", "failed", "timeout"}
