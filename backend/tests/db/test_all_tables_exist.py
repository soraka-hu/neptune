from pathlib import Path
import sys

from sqlalchemy import inspect

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.db.session import engine


def test_all_v1_tables_exist():
    expected = {
        "project",
        "suite",
        "case_item",
        "rule_definition",
        "rule_project_rel",
        "rule_suite_rel",
        "dataset",
        "dataset_item",
        "evaluator",
        "environment",
        "prompt_template",
        "run_record",
        "run_item",
        "run_log",
        "run_schedule",
        "judge_record",
        "report_record",
        "version_snapshot",
    }

    names = set(inspect(engine).get_table_names())
    assert expected.issubset(names)
