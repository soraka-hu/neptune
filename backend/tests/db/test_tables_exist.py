from pathlib import Path
import sys

from sqlalchemy import inspect

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.db.session import engine


def test_core_tables_exist():
    names = set(inspect(engine).get_table_names())
    assert "project" in names
    assert "suite" in names
    assert "case_item" in names
