from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.application.evaluation_service import EvaluationService


def test_llm_judge_uses_model_gateway_client_only(monkeypatch):
    captured = {}

    def fake_judge(*, prompt, output, expected, config, case_or_item=None):
        captured["prompt"] = prompt
        captured["output"] = output
        captured["expected"] = expected
        captured["config"] = config
        captured["case_or_item"] = case_or_item
        return {
            "score": 0.9,
            "reason": "gateway judge result",
            "dimensions": [
                {"name": "correctness", "score": 0.9, "reason": "good"},
            ],
            "model_name": "gateway-model",
            "model_version": "v1",
        }

    monkeypatch.setattr(
        "app.infrastructure.llm.model_gateway_client.ModelGatewayClient.judge",
        staticmethod(fake_judge),
    )

    score_result = EvaluationService().evaluate(
        case_or_item={"id": 2},
        output={"answer": "订单已创建"},
        expected={"reference_answer": {"answer": "订单已创建"}},
        evaluator_config={
            "threshold": 0.8,
            "evaluators": [
                {
                    "type": "llm_judge",
                    "weight": 1.0,
                    "prompt_template": "Judge this answer",
                },
            ],
        },
    )

    assert captured["prompt"] == "Judge this answer"
    assert captured["output"] == {"answer": "订单已创建"}
    assert captured["expected"] == {"reference_answer": {"answer": "订单已创建"}}
    assert captured["case_or_item"] == {"id": 2}
    assert score_result["total_score"] == 0.9
    assert score_result["passed"] is True
    assert score_result["dimensions"][0]["name"] == "correctness"
