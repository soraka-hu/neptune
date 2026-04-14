from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from app.infrastructure.pytest_runner.yaml_renderer import YamlRenderer


class PytestRunnerAdapter:
    def __init__(self, yaml_renderer: YamlRenderer | None = None) -> None:
        self.yaml_renderer = yaml_renderer or YamlRenderer()

    def execute_api_case(
        self,
        run_record: dict[str, Any],
        run_item: dict[str, Any],
        case_item: dict[str, Any],
        environment: dict[str, Any] | None = None,
        bound_rules: list[dict[str, Any]] | None = None,
        on_attempt: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        rendered_yaml = self.yaml_renderer.render_run_item_config(
            run_record=run_record,
            run_item=run_item,
            case_item=case_item,
        )

        input_payload = case_item.get("input_payload") or {}
        expected_output = case_item.get("expected_output") if isinstance(case_item.get("expected_output"), dict) else {}
        assertion_config = case_item.get("assertion_config") if isinstance(case_item.get("assertion_config"), dict) else {}

        # 优先使用实时环境 headers；用例 headers 只补充环境中不存在的键
        merged_headers = self._merge_headers(input_payload.get("headers"), (environment or {}).get("headers"))
        request_data = {
            **(run_item.get("request_data") or {}),
            "rendered_yaml_path": str(rendered_yaml),
            "method": input_payload.get("method"),
            "path": input_payload.get("path"),
            "headers": merged_headers,
            "query": input_payload.get("query") or {},
            "body": input_payload.get("body"),
            "base_url": (environment or {}).get("base_url"),
            "environment_resolve_mode": "live",
            "environment_id": run_record.get("environment_id"),
        }
        assertion_rules = self._extract_assertion_rules(bound_rules or [])
        execution_rules = self._extract_execution_rules(bound_rules or [])
        case_execution_config = self._extract_case_execution_config(case_item=case_item, assertion_config=assertion_config)
        timeout_seconds = self._resolve_timeout_seconds(
            execution_rules=execution_rules,
            case_execution_config=case_execution_config,
        )
        retry_count, retry_interval_seconds = self._resolve_retry_policy(
            execution_rules=execution_rules,
            case_execution_config=case_execution_config,
        )
        if execution_rules:
            request_data["execution_policy"] = execution_rules[0].get("content") or {}
        if case_execution_config:
            request_data["case_execution_policy"] = case_execution_config
        request_data["timeout_seconds"] = timeout_seconds
        request_data["retry_count"] = retry_count
        request_data["retry_interval_seconds"] = retry_interval_seconds

        response_data: dict[str, Any] = {
            "url": None,
            "status_code": None,
            "headers": {},
            "text": "",
            "json": None,
        }
        error_info: dict[str, Any] | None = None
        case_assertion: dict[str, Any] = {
            "source_mode": "none",
            "strategy": None,
            "expected_status": None,
            "expected_json_fields": None,
            "status_code_check": True,
            "json_fields_check": True,
            "item_checks": [],
            "status_checks": [],
            "passed": True,
        }
        rule_assertions: list[dict[str, Any]] = []
        passed = False
        attempt_records: list[dict[str, Any]] = []

        for attempt in range(retry_count + 1):
            response_data, error_info = self._dispatch_http_request(
                method=input_payload.get("method"),
                path=input_payload.get("path"),
                headers=merged_headers,
                query=input_payload.get("query"),
                body=input_payload.get("body"),
                base_url=(environment or {}).get("base_url"),
                timeout_seconds=timeout_seconds,
            )

            case_assertion = self._evaluate_case_level_assertion(
                expected_output=expected_output,
                assertion_config=assertion_config,
                response_data=response_data,
            )

            passed = case_assertion["passed"] and error_info is None
            rule_assertions = []
            for assertion_rule in assertion_rules:
                checks = self._evaluate_rule_assertion(assertion_rule, response_data)
                rule_assertions.append(checks)
                passed = passed and checks["passed"]

            attempt_checks = self._build_attempt_checks(case_assertion=case_assertion)
            attempt_records.append(
                {
                    "attempt": attempt + 1,
                    "status_code": response_data.get("status_code"),
                    "assertion_passed": passed,
                    "error_type": error_info.get("type") if isinstance(error_info, dict) else None,
                    "checks": attempt_checks,
                }
            )
            if callable(on_attempt):
                on_attempt(
                    {
                        "attempt": attempt + 1,
                        "max_attempts": retry_count + 1,
                        "retry_count": retry_count,
                        "retry_interval_seconds": retry_interval_seconds,
                        "timeout_seconds": timeout_seconds,
                        "request_url": response_data.get("url"),
                        "status_code": response_data.get("status_code"),
                        "assertion_passed": passed,
                        "error_type": error_info.get("type") if isinstance(error_info, dict) else None,
                        "response_json": response_data.get("json"),
                        "check_results": attempt_checks,
                    }
                )
            if passed:
                break
            if attempt < retry_count and retry_interval_seconds > 0:
                time.sleep(retry_interval_seconds)

        request_data["url"] = response_data.get("url")
        request_data["attempt_count"] = len(attempt_records)
        request_data["attempts"] = attempt_records

        effective_checks = [
            *case_assertion["item_checks"],
            *[
                {
                    "source": f"rule#{item['rule_id']}",
                    "rule_id": item["rule_id"],
                    "rule_name": item.get("rule_name"),
                    "path": check["path"],
                    "op": check["op"],
                    "expected": check["expected"],
                    "actual": check["actual"],
                    "passed": check["passed"],
                }
                for item in rule_assertions
                for check in item.get("item_checks", [])
                if isinstance(check, dict)
            ],
        ]

        status_checks = [
            *case_assertion["status_checks"],
            *[
                {
                    "source": f"rule#{item['rule_id']}",
                    "rule_id": item["rule_id"],
                    "rule_name": item.get("rule_name"),
                    "expected": item.get("expected_status_code"),
                    "actual": response_data.get("status_code"),
                    "passed": item.get("status_code_check") is True,
                }
                for item in rule_assertions
                if item.get("expected_status_code") is not None
            ],
        ]

        assertion_result = {
            "passed": passed,
            "source_mode": case_assertion.get("source_mode"),
            "status_code_check": case_assertion.get("status_code_check"),
            "json_fields_check": case_assertion.get("json_fields_check"),
            "applied_rule_ids": [rule["id"] for rule in assertion_rules],
            "rule_assertions": rule_assertions,
            "case_assertion": case_assertion,
            "status_checks": status_checks,
            "effective_checks": effective_checks,
        }
        assertion_error_info = self._build_assertion_error_info(
            passed=passed,
            response_data=response_data,
            case_assertion=case_assertion,
            assertion_result=assertion_result,
        )

        now = datetime.now(timezone.utc)
        result = {
            "request_data": request_data,
            "response_data": response_data,
            "assertion_result": assertion_result,
            "status": "success" if passed else "failed",
            "started_at": now,
            "finished_at": now,
        }
        if error_info is not None:
            result["error_info"] = error_info
        elif assertion_error_info is not None:
            result["error_info"] = assertion_error_info
        return result

    def _dispatch_http_request(
        self,
        *,
        method: Any,
        path: Any,
        headers: Any,
        query: Any,
        body: Any,
        base_url: Any,
        timeout_seconds: float,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        request_method = str(method or "GET").upper()
        request_path = str(path or "").strip()
        if not request_path:
            return (
                {
                    "url": None,
                    "status_code": None,
                    "headers": {},
                    "text": "",
                    "json": None,
                },
                {"type": "invalid_request", "message": "missing request path"},
            )

        request_url = self._build_request_url(base_url=base_url, path=request_path, query=query)
        if request_url is None:
            return (
                {
                    "url": None,
                    "status_code": None,
                    "headers": {},
                    "text": "",
                    "json": None,
                },
                {"type": "invalid_request", "message": "missing base_url for relative path"},
            )

        request_headers = self._merge_headers(headers, None)
        payload_bytes = self._encode_body(body, request_headers)
        request_obj = urllib_request.Request(
            request_url,
            data=payload_bytes,
            method=request_method,
            headers=request_headers,
        )

        try:
            with urllib_request.urlopen(request_obj, timeout=timeout_seconds) as response:
                status_code = response.getcode()
                response_headers = {key: value for key, value in response.headers.items()}
                raw_body = response.read() or b""
        except urllib_error.HTTPError as exc:
            status_code = exc.code
            response_headers = {key: value for key, value in exc.headers.items()} if exc.headers else {}
            raw_body = exc.read() or b""
        except Exception as exc:
            return (
                {
                    "url": request_url,
                    "status_code": None,
                    "headers": {},
                    "text": "",
                    "json": None,
                },
                {"type": exc.__class__.__name__, "message": str(exc)},
            )

        body_text = raw_body.decode("utf-8", errors="replace")
        json_payload = self._parse_response_json(body_text, response_headers.get("Content-Type"))
        return (
            {
                "url": request_url,
                "status_code": status_code,
                "headers": response_headers,
                "text": body_text,
                "json": json_payload,
            },
            None,
        )

    @staticmethod
    def _merge_headers(environment_headers: Any, case_headers: Any) -> dict[str, str]:
        result: dict[str, str] = {}
        for source in (environment_headers, case_headers):
            if not isinstance(source, dict):
                continue
            for key, value in source.items():
                if key is None or value is None:
                    continue
                result[str(key)] = str(value)
        return result

    @staticmethod
    def _encode_body(body: Any, headers: dict[str, str]) -> bytes | None:
        if body is None:
            return None
        if isinstance(body, bytes):
            return body
        if isinstance(body, (dict, list)):
            headers.setdefault("Content-Type", "application/json")
            return json.dumps(body, ensure_ascii=False).encode("utf-8")
        if isinstance(body, str):
            return body.encode("utf-8")
        if isinstance(body, (int, float, bool)):
            return str(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
        return json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")

    def _build_request_url(self, *, base_url: Any, path: str, query: Any) -> str | None:
        candidate_path = path.strip()
        if candidate_path.startswith(("http://", "https://")):
            base_target = candidate_path
        else:
            if not isinstance(base_url, str) or not base_url.strip():
                return None
            base_target = urllib_parse.urljoin(base_url.rstrip("/") + "/", candidate_path.lstrip("/"))

        parsed = urllib_parse.urlparse(base_target)
        pairs = urllib_parse.parse_qsl(parsed.query, keep_blank_values=True)
        if isinstance(query, dict):
            for key, value in query.items():
                if value is None:
                    continue
                if isinstance(value, (list, tuple)):
                    for item in value:
                        pairs.append((str(key), self._stringify_query_value(item)))
                else:
                    pairs.append((str(key), self._stringify_query_value(value)))
        encoded_query = urllib_parse.urlencode(pairs, doseq=True)
        return urllib_parse.urlunparse(
            (parsed.scheme, parsed.netloc, parsed.path, parsed.params, encoded_query, parsed.fragment)
        )

    @staticmethod
    def _stringify_query_value(value: Any) -> str:
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    @staticmethod
    def _parse_response_json(body_text: str, content_type: str | None) -> Any:
        if not body_text:
            return None
        normalized_type = (content_type or "").lower()
        if "event-stream" in normalized_type or PytestRunnerAdapter._looks_like_sse_payload(body_text):
            parsed_stream = PytestRunnerAdapter._parse_sse_stream(body_text)
            if parsed_stream is not None:
                return parsed_stream
        looks_like_json = body_text.lstrip().startswith("{") or body_text.lstrip().startswith("[")
        if "json" not in normalized_type and not looks_like_json:
            return None
        try:
            return json.loads(body_text)
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _looks_like_sse_payload(body_text: str) -> bool:
        for raw_line in body_text.splitlines():
            stripped = raw_line.strip()
            if stripped.startswith("data:"):
                return True
        return False

    @staticmethod
    def _parse_sse_stream(body_text: str) -> dict[str, Any] | None:
        events: list[dict[str, Any]] = []
        data_lines: list[str] = []

        def flush() -> None:
            nonlocal data_lines
            if not data_lines:
                return
            payload_text = "\n".join(data_lines).strip()
            data_lines = []
            if not payload_text or payload_text == "[DONE]":
                return
            try:
                parsed = json.loads(payload_text)
            except json.JSONDecodeError:
                return
            if isinstance(parsed, dict):
                events.append(parsed)

        for raw_line in body_text.splitlines():
            line = raw_line.rstrip("\r")
            stripped = line.strip()
            if not stripped:
                flush()
                continue
            if stripped.startswith("data:"):
                data_lines.append(stripped[5:].strip())
        flush()

        if not events:
            return None

        merged_text_parts: list[str] = []
        for event in events:
            event_data = event.get("data")
            if isinstance(event_data, dict):
                part = event_data.get("text")
                if isinstance(part, str) and part:
                    merged_text_parts.append(part)
        merged_text = "".join(merged_text_parts)

        last_event = events[-1]
        last_data = last_event.get("data") if isinstance(last_event.get("data"), dict) else {}
        if not isinstance(last_data, dict):
            last_data = {}
        merged_data = dict(last_data)
        merged_data["text"] = merged_text
        if "finished" not in merged_data:
            merged_data["finished"] = any(
                isinstance(item.get("data"), dict) and item["data"].get("finished") is True for item in events
            )

        result: dict[str, Any] = {
            "code": last_event.get("code"),
            "msg": last_event.get("msg"),
            "data": merged_data,
            "stream_events": events,
            "stream_event_count": len(events),
        }
        return result

    @staticmethod
    def _resolve_timeout_seconds(
        *,
        execution_rules: list[dict[str, Any]],
        case_execution_config: dict[str, Any] | None = None,
    ) -> float:
        default_timeout_ms = 8000
        if execution_rules:
            content = execution_rules[0].get("content")
            if isinstance(content, dict):
                raw_timeout = content.get("timeout_ms")
                timeout_value = PytestRunnerAdapter._coerce_non_negative_int(raw_timeout)
                if timeout_value is not None:
                    default_timeout_ms = timeout_value
        if case_execution_config:
            timeout_value = PytestRunnerAdapter._coerce_non_negative_int(case_execution_config.get("timeout_ms"))
            if timeout_value is not None:
                default_timeout_ms = timeout_value
        return max(0.1, default_timeout_ms / 1000)

    @staticmethod
    def _resolve_retry_policy(
        *,
        execution_rules: list[dict[str, Any]],
        case_execution_config: dict[str, Any] | None = None,
    ) -> tuple[int, float]:
        retry_count = 0
        retry_interval_ms = 300
        if execution_rules:
            content = execution_rules[0].get("content")
            if isinstance(content, dict):
                rule_retry_count = PytestRunnerAdapter._coerce_non_negative_int(content.get("retry_count"))
                if rule_retry_count is not None:
                    retry_count = rule_retry_count
                rule_retry_interval = PytestRunnerAdapter._coerce_non_negative_int(content.get("retry_interval_ms"))
                if rule_retry_interval is not None:
                    retry_interval_ms = rule_retry_interval
        if case_execution_config:
            case_retry_count = PytestRunnerAdapter._coerce_non_negative_int(case_execution_config.get("retry_count"))
            if case_retry_count is not None:
                retry_count = case_retry_count
            case_retry_interval = PytestRunnerAdapter._coerce_non_negative_int(case_execution_config.get("retry_interval_ms"))
            if case_retry_interval is not None:
                retry_interval_ms = case_retry_interval
        return retry_count, retry_interval_ms / 1000

    @staticmethod
    def _extract_case_execution_config(*, case_item: dict[str, Any], assertion_config: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        raw_meta_info = case_item.get("meta_info")
        if isinstance(raw_meta_info, dict):
            execution_config = raw_meta_info.get("execution_config")
            if isinstance(execution_config, dict):
                result.update(execution_config)

        raw_case_execution = case_item.get("execution_config")
        if isinstance(raw_case_execution, dict):
            result.update(raw_case_execution)

        for key in ("timeout_ms", "retry_count", "retry_interval_ms"):
            if key in assertion_config:
                result[key] = assertion_config.get(key)
        return result

    @staticmethod
    def _coerce_non_negative_int(value: Any) -> int | None:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return max(0, int(value))
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                return max(0, int(float(text)))
            except ValueError:
                return None
        return None

    def _build_expected_output_item_checks(self, *, expected_json_fields: Any, response_data: dict[str, Any]) -> list[dict[str, Any]]:
        checks: list[dict[str, Any]] = []
        for item in self._flatten_expected_json_fields(expected_json_fields):
            actual_value = self._extract_json_path_value(response_data.get("json"), item["path"])
            checks.append(
                {
                    "source": "expected_output",
                    "path": item["path"],
                    "op": "eq",
                    "expected": item["value"],
                    "actual": actual_value,
                    "passed": actual_value == item["value"],
                }
            )
        return checks

    def _evaluate_case_level_assertion(
        self,
        *,
        expected_output: dict[str, Any],
        assertion_config: dict[str, Any],
        response_data: dict[str, Any],
    ) -> dict[str, Any]:
        if self._has_assertion_config_inputs(assertion_config):
            return self._evaluate_case_assertion(assertion_config=assertion_config, response_data=response_data)
        if self._has_expected_output_inputs(expected_output):
            return self._evaluate_expected_output_assertion(expected_output=expected_output, response_data=response_data)
        return {
            "source_mode": "none",
            "strategy": None,
            "expected_status": None,
            "expected_json_fields": None,
            "status_code_check": True,
            "json_fields_check": True,
            "item_checks": [],
            "status_checks": [],
            "passed": True,
        }

    @staticmethod
    def _has_expected_output_inputs(expected_output: dict[str, Any]) -> bool:
        raw_status = expected_output.get("status_code")
        json_fields = expected_output.get("json_fields")
        if isinstance(raw_status, (int, float)):
            return True
        if isinstance(json_fields, dict):
            return len(json_fields) > 0
        if isinstance(json_fields, list):
            return len(json_fields) > 0
        return False

    @staticmethod
    def _has_assertion_config_inputs(assertion_config: dict[str, Any]) -> bool:
        for key in ("expected_status_code", "status_code"):
            if isinstance(assertion_config.get(key), (int, float)):
                return True
        for key in ("checks", "assertion_items"):
            value = assertion_config.get(key)
            if isinstance(value, list) and any(isinstance(item, dict) for item in value):
                return True
        return False

    def _evaluate_expected_output_assertion(self, *, expected_output: dict[str, Any], response_data: dict[str, Any]) -> dict[str, Any]:
        raw_status = expected_output.get("status_code")
        expected_status = int(raw_status) if isinstance(raw_status, (int, float)) else None
        expected_json_fields = expected_output.get("json_fields")

        status_checks: list[dict[str, Any]] = []
        status_ok = True
        if expected_status is not None:
            status_ok = response_data.get("status_code") == expected_status
            status_checks.append(
                {
                    "source": "expected_output",
                    "expected": expected_status,
                    "actual": response_data.get("status_code"),
                    "passed": status_ok,
                }
            )

        json_ok = True
        item_checks: list[dict[str, Any]] = []
        if isinstance(expected_json_fields, (dict, list)):
            json_ok = self._json_contains_expected_fields(response_data.get("json"), expected_json_fields)
            item_checks = self._build_expected_output_item_checks(expected_json_fields=expected_json_fields, response_data=response_data)

        return {
            "source_mode": "expected_output",
            "strategy": "expected_output",
            "expected_status": expected_status,
            "expected_json_fields": expected_json_fields if isinstance(expected_json_fields, (dict, list)) else None,
            "status_code_check": status_ok,
            "json_fields_check": json_ok,
            "item_checks": item_checks,
            "status_checks": status_checks,
            "passed": status_ok and json_ok,
        }

    def _evaluate_case_assertion(self, *, assertion_config: dict[str, Any], response_data: dict[str, Any]) -> dict[str, Any]:
        content = assertion_config if isinstance(assertion_config, dict) else {}
        raw_checks: list[dict[str, Any]] = []
        for key in ("checks", "assertion_items"):
            value = content.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        raw_checks.append(item)
        item_checks = self._evaluate_assertion_items(raw_checks, response_data)

        status_checks: list[dict[str, Any]] = []
        for key in ("expected_status_code", "status_code"):
            raw_value = content.get(key)
            if isinstance(raw_value, (int, float)):
                expected = int(raw_value)
                status_checks.append(
                    {
                        "source": "case_assertion_config",
                        "expected": expected,
                        "actual": response_data.get("status_code"),
                        "passed": response_data.get("status_code") == expected,
                    }
                )
                break

        passed = all(item["passed"] for item in item_checks) if item_checks else True
        passed = passed and (all(item["passed"] for item in status_checks) if status_checks else True)
        return {
            "source_mode": "assertion_config",
            "strategy": content.get("strategy"),
            "expected_status": next((item.get("expected") for item in status_checks if isinstance(item, dict)), None),
            "expected_json_fields": None,
            "status_code_check": all(item["passed"] for item in status_checks) if status_checks else True,
            "json_fields_check": all(item["passed"] for item in item_checks) if item_checks else True,
            "item_checks": item_checks,
            "status_checks": status_checks,
            "passed": passed,
        }

    @staticmethod
    def _build_attempt_checks(*, case_assertion: dict[str, Any]) -> list[dict[str, Any]]:
        checks: list[dict[str, Any]] = []
        item_checks = case_assertion.get("item_checks")
        if isinstance(item_checks, list):
            for item in item_checks:
                if not isinstance(item, dict):
                    continue
                checks.append(
                    {
                        "path": item.get("path"),
                        "op": item.get("op"),
                        "expected": item.get("expected"),
                        "actual": item.get("actual"),
                        "passed": item.get("passed"),
                    }
                )

        status_checks = case_assertion.get("status_checks")
        if isinstance(status_checks, list):
            for item in status_checks:
                if not isinstance(item, dict):
                    continue
                checks.append(
                    {
                        "path": "$status_code",
                        "op": "eq",
                        "expected": item.get("expected"),
                        "actual": item.get("actual"),
                        "passed": item.get("passed"),
                    }
                )
        return checks

    @staticmethod
    def _flatten_expected_json_fields(expected: Any, *, path_prefix: str = "$") -> list[dict[str, Any]]:
        if not isinstance(expected, dict):
            return []
        checks: list[dict[str, Any]] = []
        for key, value in expected.items():
            current_path = f"{path_prefix}.{key}" if path_prefix else key
            if isinstance(value, dict):
                checks.extend(PytestRunnerAdapter._flatten_expected_json_fields(value, path_prefix=current_path))
            else:
                checks.append({"path": current_path, "value": value})
        return checks

    def _evaluate_assertion_items(self, raw_items: list[dict[str, Any]], response_data: dict[str, Any]) -> list[dict[str, Any]]:
        item_results: list[dict[str, Any]] = []
        for item in raw_items:
            path = item.get("path") if isinstance(item.get("path"), str) else item.get("field_path")
            if not isinstance(path, str) or not path.strip():
                continue
            op = item.get("op") if isinstance(item.get("op"), str) else "eq"
            expected_value = item.get("value")
            actual_value = self._extract_json_path_value(response_data.get("json"), path)
            passed = self._evaluate_operator(op, actual_value, expected_value)
            item_results.append(
                {
                    "path": path,
                    "op": op,
                    "expected": expected_value,
                    "actual": actual_value,
                    "passed": passed,
                }
            )
        return item_results

    def _build_assertion_error_info(
        self,
        *,
        passed: bool,
        response_data: dict[str, Any],
        case_assertion: dict[str, Any],
        assertion_result: dict[str, Any],
    ) -> dict[str, Any] | None:
        if passed:
            return None

        failure_reasons: list[str] = []
        source_mode = case_assertion.get("source_mode")
        status_checks = case_assertion.get("status_checks")
        if isinstance(status_checks, list):
            for check in status_checks:
                if not isinstance(check, dict) or check.get("passed") is True:
                    continue
                expected_value = check.get("expected")
                actual_value = check.get("actual")
                failure_reasons.append(f"status_code mismatch (expected={expected_value}, actual={actual_value})")

        item_checks = case_assertion.get("item_checks")
        if isinstance(item_checks, list):
            failed_items = [item for item in item_checks if isinstance(item, dict) and item.get("passed") is False]
            for item in failed_items[:3]:
                path = item.get("path") if isinstance(item.get("path"), str) else "$"
                op = item.get("op") if isinstance(item.get("op"), str) else "eq"
                expected_value = item.get("expected")
                actual_value = item.get("actual")
                failure_reasons.append(f"{path} {op} check failed (expected={expected_value}, actual={actual_value})")

            if source_mode == "expected_output" and assertion_result.get("json_fields_check") is False:
                response_headers = response_data.get("headers")
                content_type = ""
                if isinstance(response_headers, dict):
                    content_type = str(response_headers.get("Content-Type") or "")
                if response_data.get("json") is None:
                    if content_type:
                        failure_reasons.append(f"expected JSON fields but response Content-Type is {content_type}")
                    else:
                        failure_reasons.append("expected JSON fields but response is not valid JSON")
                else:
                    failure_reasons.append("response JSON does not contain expected fields")

        rule_assertions = assertion_result.get("rule_assertions")
        if isinstance(rule_assertions, list):
            failed_rules = [
                item
                for item in rule_assertions
                if isinstance(item, dict) and item.get("passed") is False
            ]
            if failed_rules:
                failed_rule_names: list[str] = []
                for item in failed_rules[:3]:
                    name = item.get("rule_name")
                    if isinstance(name, str) and name.strip():
                        failed_rule_names.append(name.strip())
                    else:
                        failed_rule_names.append(f"rule#{item.get('rule_id')}")
                failure_reasons.append(f"rule assertions failed ({', '.join(failed_rule_names)})")

        if not failure_reasons:
            failure_reasons.append("assertion failed")

        return {
            "type": "assertion_failed",
            "message": "; ".join(failure_reasons),
            "expected_json_fields": case_assertion.get("expected_json_fields")
            if isinstance(case_assertion.get("expected_json_fields"), dict)
            else None,
        }

    def _json_contains_expected_fields(self, actual: Any, expected: Any) -> bool:
        if isinstance(expected, dict):
            if not isinstance(actual, dict):
                return False
            for key, expected_value in expected.items():
                if key not in actual:
                    return False
                if not self._json_contains_expected_fields(actual[key], expected_value):
                    return False
            return True
        if isinstance(expected, list):
            return actual == expected
        return actual == expected

    @staticmethod
    def _extract_assertion_rules(bound_rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            rule
            for rule in bound_rules
            if isinstance(rule, dict)
            and rule.get("rule_type") == "assertion"
            and isinstance(rule.get("content"), dict)
            and isinstance(rule.get("id"), int)
        ]

    @staticmethod
    def _extract_execution_rules(bound_rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            rule
            for rule in bound_rules
            if isinstance(rule, dict)
            and rule.get("rule_type") == "execution"
            and isinstance(rule.get("content"), dict)
            and isinstance(rule.get("id"), int)
        ]

    def _evaluate_rule_assertion(self, rule: dict[str, Any], response_data: dict[str, Any]) -> dict[str, Any]:
        content = rule.get("content") if isinstance(rule.get("content"), dict) else {}
        expected_status_code = content.get("expected_status_code")
        status_ok = True
        if expected_status_code is not None:
            status_ok = response_data.get("status_code") == expected_status_code

        raw_items = [item for item in content.get("assertion_items") or [] if isinstance(item, dict)]
        item_results = self._evaluate_assertion_items(raw_items, response_data)

        item_checks_ok = all(item["passed"] for item in item_results) if item_results else True
        return {
            "rule_id": rule["id"],
            "rule_name": rule.get("name"),
            "expected_status_code": expected_status_code,
            "status_code_check": status_ok,
            "item_checks": item_results,
            "passed": status_ok and item_checks_ok,
        }

    @staticmethod
    def _extract_json_path_value(payload: Any, path: str) -> Any:
        if not isinstance(payload, dict):
            return None
        normalized = path.strip()
        if normalized.startswith("$."):
            normalized = normalized[2:]
        elif normalized.startswith("$"):
            normalized = normalized[1:]
        if not normalized:
            return payload
        cursor: Any = payload
        for segment in normalized.split("."):
            if not isinstance(cursor, dict):
                return None
            cursor = cursor.get(segment)
        return cursor

    @staticmethod
    def _evaluate_operator(op: str, actual: Any, expected: Any) -> bool:
        if op == "eq":
            return actual == expected
        if op == "ne":
            return actual != expected
        if op == "contains":
            return str(expected) in str(actual)
        if op == "not_contains":
            return str(expected) not in str(actual)
        if op == "exists":
            return actual is not None
        if op in {"gt", "gte", "lt", "lte"}:
            try:
                actual_number = float(actual)
                expected_number = float(expected)
            except (TypeError, ValueError):
                return False
            if op == "gt":
                return actual_number > expected_number
            if op == "gte":
                return actual_number >= expected_number
            if op == "lt":
                return actual_number < expected_number
            return actual_number <= expected_number
        return False
