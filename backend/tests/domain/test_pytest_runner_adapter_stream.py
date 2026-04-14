from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.domain.runners.pytest_runner_adapter import PytestRunnerAdapter
from app.infrastructure.pytest_runner.yaml_renderer import YamlRenderer


def test_execute_api_case_parses_event_stream_response(tmp_path):
    adapter = PytestRunnerAdapter(yaml_renderer=YamlRenderer(base_dir=tmp_path))

    stream_text = (
        'data: {"code": 200, "msg": "message_output_created", "data": {"finished": false, "thread_id": "tid", "text": "你好"}}\n\n'
        'data: {"code": 200, "msg": "message_output_created", "data": {"finished": false, "thread_id": "tid", "text": "！有什么"}}\n\n'
        'data: {"code": 200, "msg": "run_completed", "data": {"finished": true, "thread_id": "tid", "text": ""}}\n\n'
    )

    def fake_dispatch_http_request(**_: object):
        parsed_json = adapter._parse_response_json(stream_text, "text/event-stream; charset=utf-8")
        return (
            {
                "url": "https://example.com/api/titan/v1/chat/123",
                "status_code": 200,
                "headers": {"Content-Type": "text/event-stream; charset=utf-8"},
                "text": stream_text,
                "json": parsed_json,
            },
            None,
        )

    adapter._dispatch_http_request = fake_dispatch_http_request  # type: ignore[method-assign]

    run_record = {"id": 1, "run_no": "api-test-1", "run_type": "api_test", "request_snapshot": {}}
    run_item = {"id": 1, "request_data": {}}
    case_item = {
        "id": 10,
        "name": "stream chat",
        "case_type": "api",
        "input_payload": {
            "schema_version": "1.0",
            "method": "POST",
            "path": "/api/titan/v1/chat/123",
            "headers": {"Content-Type": "application/json"},
            "query": {},
            "body": {"message": "你好"},
        },
        "expected_output": {
            "schema_version": "1.0",
            "status_code": 200,
            "json_fields": {"code": 200, "data": {"finished": True}},
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
    response_json = result["response_data"]["json"]
    assert response_json["code"] == 200
    assert response_json["data"]["finished"] is True
    assert response_json["data"]["text"] == "你好！有什么"
    assert response_json["stream_event_count"] == 3


def test_execute_api_case_treats_data_lines_as_stream_even_with_json_content_type(tmp_path):
    adapter = PytestRunnerAdapter(yaml_renderer=YamlRenderer(base_dir=tmp_path))

    stream_text = (
        "event: message\n"
        'data: {"code": 200, "msg": "message_output_created", "data": {"finished": false, "thread_id": "tid", "text": "你好"}}\n\n'
        "event: message\n"
        'data: {"code": 200, "msg": "run_completed", "data": {"finished": true, "thread_id": "tid", "text": ""}}\n\n'
    )

    def fake_dispatch_http_request(**_: object):
        parsed_json = adapter._parse_response_json(stream_text, "application/json; charset=utf-8")
        return (
            {
                "url": "https://example.com/api/titan/v1/chat/123",
                "status_code": 200,
                "headers": {"Content-Type": "application/json; charset=utf-8"},
                "text": stream_text,
                "json": parsed_json,
            },
            None,
        )

    adapter._dispatch_http_request = fake_dispatch_http_request  # type: ignore[method-assign]

    run_record = {"id": 2, "run_no": "api-test-2", "run_type": "api_test", "request_snapshot": {}}
    run_item = {"id": 2, "request_data": {}}
    case_item = {
        "id": 11,
        "name": "stream chat json header",
        "case_type": "api",
        "input_payload": {
            "schema_version": "1.0",
            "method": "POST",
            "path": "/api/titan/v1/chat/123",
            "headers": {"Content-Type": "application/json"},
            "query": {},
            "body": {"message": "你好"},
        },
        "expected_output": {
            "schema_version": "1.0",
            "status_code": 200,
            "json_fields": {"code": 200, "data": {"finished": True, "text": "你好"}},
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
    response_json = result["response_data"]["json"]
    assert response_json["code"] == 200
    assert response_json["data"]["finished"] is True
    assert response_json["data"]["text"] == "你好"
    assert response_json["stream_event_count"] == 2
