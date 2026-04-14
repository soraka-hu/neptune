from pathlib import Path
import sys
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.llm.model_gateway_client import ModelGatewayClient
from app.infrastructure.repositories.table_repository import TableRepository
from app.main import app
from app.workers.execution_worker import execute_run_item


@pytest.fixture(autouse=True)
def stub_model_gateway(monkeypatch):
    def fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        reference = (context or {}).get("reference_answer")
        if isinstance(reference, dict):
            parsed_output = reference
        elif reference is not None:
            parsed_output = {"answer": str(reference)}
        else:
            parsed_output = {"answer": str(user_input)}
        return {
            "parsed_output": parsed_output,
            "raw_output": parsed_output,
            "raw_response": {"choices": [{"message": {"content": parsed_output}}]},
            "model_name": "gateway-default",
            "model_version": "v1",
            "token_usage": {"total_tokens": 32},
            "latency_ms": 10,
        }

    def fake_judge(self, *, prompt, output, expected, config, case_or_item=None):
        expected_reference = expected.get("reference_answer", expected) if isinstance(expected, dict) else expected
        matched = output == expected_reference
        score = 0.95 if matched else 0.2
        return {
            "score": score,
            "reason": "matched reference" if matched else "did not match reference",
            "dimensions": [
                {
                    "name": "correctness",
                    "score": score,
                    "reason": "matched" if matched else "mismatch",
                }
            ],
            "model_name": "gateway-default",
            "model_version": "v1",
            "token_usage": {"total_tokens": 42},
            "latency_ms": 12,
        }

    monkeypatch.setattr(ModelGatewayClient, "complete", fake_complete)
    monkeypatch.setattr(ModelGatewayClient, "judge", fake_judge)


def test_agent_eval_persists_score_result_and_judge_record():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Agent Eval Project",
            "projectType": "hybrid",
            "description": "project for agent eval flow tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Agent Eval Suite",
            "suiteType": "agent_eval",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Agent Eval Env",
            "envType": "test",
            "baseUrl": "http://localhost:8000",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "Agent Eval Case",
            "caseType": "agent",
            "inputPayload": {
                "schema_version": "1.0",
                "user_input": "帮我总结这段需求，输出三个要点",
                "conversation_history": [],
                "tools_context": [],
                "constraints": {
                    "format": "bullet_list",
                    "language": "zh",
                },
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "reference_answer": {
                    "answer": "订单已创建",
                },
            },
            "evalConfig": {
                "schema_version": "1.0",
                "evaluation_mode": "with_reference",
                "evaluators": [
                    {
                        "type": "llm_judge",
                        "weight": 1.0,
                        "prompt_template": "Judge this answer",
                    }
                ],
                "threshold": 0.8,
            },
        },
    )
    assert case_response.status_code == 200
    case_id = case_response.json()["data"]["id"]

    dataset_response = client.post(
        "/api/datasets",
        json={
            "projectId": project_id,
            "name": "Agent Eval Dataset",
            "datasetType": "with_reference",
        },
    )
    assert dataset_response.status_code == 200
    dataset_id = dataset_response.json()["data"]["id"]

    dataset_item = TableRepository("dataset_item").create(
        {
            "dataset_id": dataset_id,
            "case_id": case_id,
            "input_data": {
                "user_input": "请给出结果",
            },
            "reference_answer": {
                "answer": "订单已创建",
            },
            "status": "active",
        }
    )

    run_response = client.post(
        "/api/runs/agent-eval",
        headers={"Idempotency-Key": f"agent-eval-{uuid4().hex}"},
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "datasetId": dataset_id,
            "environmentId": environment_id,
            "evaluationMode": "with_reference",
        },
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]

    run_item = TableRepository("run_item").list({"run_id": run_id})[0]
    assert run_item["dataset_item_id"] == dataset_item["id"]

    execute_run_item(run_item["id"])

    updated_run_item = TableRepository("run_item").get(run_item["id"])
    judge_records = TableRepository("judge_record").list({"run_item_id": run_item["id"]})

    assert updated_run_item["score_result"]["total_score"] >= 0.8
    assert updated_run_item["score_result"]["passed"] is True
    assert updated_run_item["parsed_output"]["answer"] == "订单已创建"
    assert updated_run_item["status"] == "success"
    assert len(judge_records) == 1
    assert judge_records[0]["prompt_snapshot"] == "Judge this answer"
    assert judge_records[0]["model_name"] == "gateway-default"


def test_agent_eval_can_use_selected_scoring_rule():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Agent Eval Selected Rule Project",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Agent Eval Selected Rule Suite",
            "suiteType": "agent_eval",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    environment_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "Agent Eval Selected Rule Env",
            "envType": "test",
            "baseUrl": "http://localhost:8000",
        },
    )
    assert environment_response.status_code == 200
    environment_id = environment_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "Agent Eval Selected Rule Case",
            "caseType": "agent",
            "inputPayload": {
                "schema_version": "1.0",
                "user_input": "请总结重点",
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "reference_answer": {
                    "answer": "订单已创建",
                },
            },
        },
    )
    assert case_response.status_code == 200
    case_id = case_response.json()["data"]["id"]

    scoring_rule_response = client.post(
        "/api/rules",
        json={
            "name": "Selected Scoring Rule",
            "ruleType": "scoring",
            "content": {
                "evaluation_mode": "with_reference",
                "match_type": "exact_match",
                "threshold": 0.8,
            },
        },
    )
    assert scoring_rule_response.status_code == 200
    scoring_rule_id = scoring_rule_response.json()["data"]["id"]

    dataset_response = client.post(
        "/api/datasets",
        json={
            "projectId": project_id,
            "name": "Agent Eval Selected Rule Dataset",
            "datasetType": "with_reference",
        },
    )
    assert dataset_response.status_code == 200
    dataset_id = dataset_response.json()["data"]["id"]

    dataset_item = TableRepository("dataset_item").create(
        {
            "dataset_id": dataset_id,
            "case_id": case_id,
            "input_data": {
                "user_input": "请给出结果",
            },
            "reference_answer": {
                "answer": "订单已创建",
            },
            "status": "active",
        }
    )

    run_response = client.post(
        "/api/runs/agent-eval",
        headers={"Idempotency-Key": f"agent-eval-selected-rule-{uuid4().hex}"},
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "datasetId": dataset_id,
            "environmentId": environment_id,
            "ruleIds": [scoring_rule_id],
        },
    )
    assert run_response.status_code == 200
    run_id = run_response.json()["data"]["id"]
    run_snapshot = run_response.json()["data"]["request_snapshot"]
    assert scoring_rule_id in run_snapshot["bound_rule_ids"]
    assert run_snapshot["selected_rule_ids"] == [scoring_rule_id]

    run_item = TableRepository("run_item").list({"run_id": run_id})[0]
    assert run_item["dataset_item_id"] == dataset_item["id"]

    execute_run_item(run_item["id"])
    updated_run_item = TableRepository("run_item").get(run_item["id"])
    assert updated_run_item["status"] == "success"
    assert scoring_rule_id in updated_run_item["request_data"]["bound_rule_ids"]
    assert updated_run_item["score_result"]["passed"] is True
