from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.pytest_runner.yaml_renderer import YamlRenderer


def test_yaml_render_contains_run_snapshot_version(tmp_path):
    run_record = {
        "id": 101,
        "run_no": "api-test-123",
        "run_type": "api_test",
        "request_snapshot": {
            "run_type": "api_test",
            "idempotency_key": "idem-123",
            "environment_id": 5,
        },
    }
    run_item = {
        "id": 201,
        "case_id": 301,
        "request_data": {
            "case_version": 7,
        },
    }
    case_item = {
        "id": 301,
        "name": "Create Order",
        "case_type": "api",
        "input_payload": {
            "schema_version": "1.0",
            "method": "POST",
            "path": "/api/order/create",
        },
        "expected_output": {
            "schema_version": "1.0",
            "status_code": 200,
            "json_fields": {"code": 0},
        },
    }

    rendered = YamlRenderer(base_dir=tmp_path).render_run_item_config(
        run_record=run_record,
        run_item=run_item,
        case_item=case_item,
    )

    content = rendered.read_text(encoding="utf-8")
    assert "run_id: 101" in content
    assert "run_type: api_test" in content
    assert "case_version: 7" in content
    assert "schema_version: '1.0'" in content

