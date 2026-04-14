from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.domain.runners.pytest_runner_adapter import PytestRunnerAdapter
from app.infrastructure.pytest_runner.yaml_renderer import YamlRenderer


def test_execute_api_case_records_assertion_error_for_non_json_response(tmp_path):
    adapter = PytestRunnerAdapter(yaml_renderer=YamlRenderer(base_dir=tmp_path))

    def fake_dispatch_http_request(**_: object):
        return (
            {
                "url": "https://example.com/chat/123",
                "status_code": 200,
                "headers": {"Content-Type": "text/html; charset=utf-8"},
                "text": "<!DOCTYPE html><html></html>",
                "json": None,
            },
            None,
        )

    adapter._dispatch_http_request = fake_dispatch_http_request  # type: ignore[method-assign]

    run_record = {"id": 1, "run_no": "api-test-1", "run_type": "api_test", "request_snapshot": {}}
    run_item = {"id": 1, "request_data": {}}
    case_item = {
        "id": 10,
        "name": "chat ok",
        "case_type": "api",
        "input_payload": {
            "schema_version": "1.0",
            "method": "POST",
            "path": "/chat/123",
            "headers": {"Content-Type": "application/json"},
            "query": {},
            "body": {"message": "hello"},
        },
        "expected_output": {
            "schema_version": "1.0",
            "status_code": 200,
            "json_fields": {"code": 0, "message": "success"},
        },
    }

    result = adapter.execute_api_case(
        run_record=run_record,
        run_item=run_item,
        case_item=case_item,
        environment={"base_url": "https://example.com"},
        bound_rules=[],
    )

    assert result["status"] == "failed"
    assert result["assertion_result"]["passed"] is False
    assert result["assertion_result"]["json_fields_check"] is False
    assert result["error_info"]["type"] == "assertion_failed"
    assert "Content-Type is text/html; charset=utf-8" in result["error_info"]["message"]


def test_execute_api_case_prefers_assertion_config_over_expected_output(tmp_path):
    adapter = PytestRunnerAdapter(yaml_renderer=YamlRenderer(base_dir=tmp_path))

    def fake_dispatch_http_request(**_: object):
        return (
            {
                "url": "https://example.com/chat/123",
                "status_code": 200,
                "headers": {"Content-Type": "application/json"},
                "text": '{"code": 0, "message": "success"}',
                "json": {"code": 0, "message": "success"},
            },
            None,
        )

    adapter._dispatch_http_request = fake_dispatch_http_request  # type: ignore[method-assign]

    run_record = {"id": 2, "run_no": "api-test-2", "run_type": "api_test", "request_snapshot": {}}
    run_item = {"id": 2, "request_data": {}}
    case_item = {
        "id": 11,
        "name": "chat ok",
        "case_type": "api",
        "input_payload": {"schema_version": "1.0", "method": "POST", "path": "/chat/123"},
        "expected_output": {
            "schema_version": "1.0",
            "status_code": 400,
            "json_fields": {"code": 2001},
        },
        "assertion_config": {
            "strategy": "json_fields",
            "checks": [
                {"path": "$.code", "op": "eq", "value": 0},
                {"path": "$.message", "op": "eq", "value": "success"},
            ],
        },
    }

    result = adapter.execute_api_case(
        run_record=run_record,
        run_item=run_item,
        case_item=case_item,
        environment={"base_url": "https://example.com"},
        bound_rules=[],
    )

    assert result["status"] == "success"
    assert result["assertion_result"]["source_mode"] == "assertion_config"
    assert result["assertion_result"]["json_fields_check"] is True
    assert result["request_data"]["attempt_count"] == 1
    assert len(result["request_data"]["attempts"]) == 1
    assert result["request_data"]["attempts"][0]["attempt"] == 1
    assert result["request_data"]["attempts"][0]["assertion_passed"] is True
    assert isinstance(result["request_data"]["attempts"][0]["checks"], list)


def test_execute_api_case_retries_until_assertion_passed(tmp_path):
    adapter = PytestRunnerAdapter(yaml_renderer=YamlRenderer(base_dir=tmp_path))
    call_counter = {"count": 0}

    def fake_dispatch_http_request(**_: object):
        call_counter["count"] += 1
        status_value = 1 if call_counter["count"] >= 3 else 0
        return (
            {
                "url": "https://example.com/task/123",
                "status_code": 200,
                "headers": {"Content-Type": "application/json"},
                "text": '{"status": %d}' % status_value,
                "json": {"status": status_value},
            },
            None,
        )

    adapter._dispatch_http_request = fake_dispatch_http_request  # type: ignore[method-assign]

    run_record = {
        "id": 3,
        "run_no": "api-test-3",
        "run_type": "api_test",
        "request_snapshot": {
            "bound_rules": [
                {
                    "id": -1,
                    "name": "custom_execution_config",
                    "rule_type": "execution",
                    "content": {
                        "timeout_ms": 3000,
                        "retry_count": 5,
                        "retry_interval_ms": 0,
                    },
                }
            ]
        },
    }
    run_item = {"id": 3, "request_data": {}}
    case_item = {
        "id": 12,
        "name": "polling case",
        "case_type": "api",
        "input_payload": {"schema_version": "1.0", "method": "GET", "path": "/task/123"},
        "assertion_config": {
            "checks": [
                {"path": "$.status", "op": "eq", "value": 1},
            ]
        },
    }

    result = adapter.execute_api_case(
        run_record=run_record,
        run_item=run_item,
        case_item=case_item,
        environment={"base_url": "https://example.com"},
        bound_rules=run_record["request_snapshot"]["bound_rules"],
    )

    assert result["status"] == "success"
    assert call_counter["count"] == 3
    assert result["request_data"]["attempt_count"] == 3
    assert result["response_data"]["json"]["status"] == 1
    assert result["assertion_result"]["passed"] is True


def test_execute_api_case_case_level_execution_policy_overrides_rule(tmp_path):
    adapter = PytestRunnerAdapter(yaml_renderer=YamlRenderer(base_dir=tmp_path))
    call_counter = {"count": 0}
    observed_timeouts: list[float] = []

    def fake_dispatch_http_request(**kwargs: object):
        call_counter["count"] += 1
        timeout_seconds = kwargs.get("timeout_seconds")
        if isinstance(timeout_seconds, (int, float)):
            observed_timeouts.append(float(timeout_seconds))
        status_value = 1 if call_counter["count"] >= 3 else 0
        return (
            {
                "url": "https://example.com/task/override",
                "status_code": 200,
                "headers": {"Content-Type": "application/json"},
                "text": '{"status": %d}' % status_value,
                "json": {"status": status_value},
            },
            None,
        )

    adapter._dispatch_http_request = fake_dispatch_http_request  # type: ignore[method-assign]

    bound_rules = [
        {
            "id": -1,
            "name": "custom_execution_config",
            "rule_type": "execution",
            "content": {
                "timeout_ms": 9000,
                "retry_count": 0,
                "retry_interval_ms": 100,
            },
        }
    ]
    run_record = {
        "id": 4,
        "run_no": "api-test-4",
        "run_type": "api_test",
        "request_snapshot": {
            "bound_rules": bound_rules,
        },
    }
    run_item = {"id": 4, "request_data": {}}
    case_item = {
        "id": 13,
        "name": "polling case override",
        "case_type": "api",
        "input_payload": {"schema_version": "1.0", "method": "GET", "path": "/task/override"},
        "assertion_config": {
            "timeout_ms": 2500,
            "retry_count": 4,
            "retry_interval_ms": 0,
            "checks": [
                {"path": "$.status", "op": "eq", "value": 1},
            ],
        },
    }

    result = adapter.execute_api_case(
        run_record=run_record,
        run_item=run_item,
        case_item=case_item,
        environment={"base_url": "https://example.com"},
        bound_rules=bound_rules,
    )

    assert result["status"] == "success"
    assert call_counter["count"] == 3
    assert result["request_data"]["attempt_count"] == 3
    assert result["request_data"]["retry_count"] == 4
    assert result["request_data"]["retry_interval_seconds"] == 0
    assert result["request_data"]["timeout_seconds"] == 2.5
    assert result["request_data"]["case_execution_policy"]["timeout_ms"] == 2500
    assert observed_timeouts == [2.5, 2.5, 2.5]
