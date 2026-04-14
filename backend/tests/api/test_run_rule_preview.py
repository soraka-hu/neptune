from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def test_run_rule_preview_returns_bound_rules_for_project_and_suite():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={"name": "Run Preview Project", "projectType": "hybrid"},
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={"projectId": project_id, "name": "Run Preview Suite", "suiteType": "api"},
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    assertion_rule = client.post(
        "/api/rules",
        json={
            "name": "Bound Assertion Rule",
            "ruleType": "assertion",
            "content": {"status_code": 200},
        },
    )
    assert assertion_rule.status_code == 200
    assertion_rule_id = assertion_rule.json()["data"]["id"]

    manual_assertion_rule = client.post(
        "/api/rules",
        json={
            "name": "Manual Assertion Rule",
            "ruleType": "assertion",
            "content": {"status_code": 200},
        },
    )
    assert manual_assertion_rule.status_code == 200
    manual_assertion_rule_id = manual_assertion_rule.json()["data"]["id"]

    bind_assertion = client.post(f"/api/rules/{assertion_rule_id}/bind-suites", json={"suiteIds": [suite_id]})
    assert bind_assertion.status_code == 200

    preview = client.post(
        "/api/runs/rule-preview",
        json={
            "runType": "api_test",
            "projectId": project_id,
            "suiteId": suite_id,
        },
    )
    assert preview.status_code == 200
    payload = preview.json()["data"]
    assert payload["run_type"] == "api_test"
    assert payload["strategy_mode"] == "binding_auto"
    assert any(item["id"] == assertion_rule_id for item in payload["auto_bound_rules"])
    assert any(item["id"] == assertion_rule_id for item in payload["effective_rules"])

    preview_with_selected = client.post(
        "/api/runs/rule-preview",
        json={
            "runType": "api_test",
            "projectId": project_id,
            "suiteId": suite_id,
            "executionRuleId": manual_assertion_rule_id,
        },
    )
    assert preview_with_selected.status_code == 200
    selected_payload = preview_with_selected.json()["data"]
    assert selected_payload["strategy_mode"] == "selected_rule"
    assert manual_assertion_rule_id in selected_payload["selected_rule_ids"]
    assert any(item["id"] == manual_assertion_rule_id for item in selected_payload["effective_rules"])


def test_run_rule_preview_normalizes_benchmark_run_type():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={"name": "Benchmark Preview Project", "projectType": "hybrid"},
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={"projectId": project_id, "name": "Benchmark Preview Suite", "suiteType": "agent_eval"},
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    scoring_rule = client.post(
        "/api/rules",
        json={
            "name": "Benchmark Scoring Rule",
            "ruleType": "scoring",
            "content": {"threshold": 0.8},
        },
    )
    assert scoring_rule.status_code == 200
    scoring_rule_id = scoring_rule.json()["data"]["id"]

    preview = client.post(
        "/api/runs/rule-preview",
        json={
            "runType": "benchmark",
            "projectId": project_id,
            "suiteId": suite_id,
            "scoringRuleId": scoring_rule_id,
        },
    )
    assert preview.status_code == 200
    payload = preview.json()["data"]
    assert payload["run_type"] == "agent_eval"
    assert payload["strategy_mode"] == "selected_rule"
    assert scoring_rule_id in payload["selected_rule_ids"]
