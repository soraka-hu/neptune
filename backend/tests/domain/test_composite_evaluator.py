from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.application.evaluation_service import EvaluationService


def test_composite_evaluator_weighted_total_score():
    service = EvaluationService()

    score_result = service.evaluate(
        case_or_item={"id": 1},
        output={"summary_points": ["要点1", "要点2", "要点3"]},
        expected={
            "reference_answer": {
                "summary_points": ["要点1", "要点2", "要点3"],
            },
            "must_include": ["要点1"],
        },
        evaluator_config={
            "threshold": 0.8,
            "evaluators": [
                {"type": "json_match", "weight": 0.4},
                {
                    "type": "rule_based",
                    "weight": 0.6,
                    "rules": [
                        {"type": "must_include", "values": ["要点1"]},
                    ],
                },
            ],
        },
    )

    assert score_result["total_score"] == 1.0
    assert score_result["passed"] is True
    assert score_result["threshold"] == 0.8
    assert len(score_result["dimensions"]) == 2
    assert score_result["dimensions"][0]["weight"] == 0.4
    assert score_result["dimensions"][1]["weight"] == 0.6
