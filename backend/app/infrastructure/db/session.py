from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _default_sqlite_url() -> str:
    runtime_dir = Path(__file__).resolve().parents[3] / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite+pysqlite:///{runtime_dir / 'unified_test_eval.sqlite3'}"


DATABASE_URL = os.getenv("DATABASE_URL", _default_sqlite_url())

engine = create_engine(
    DATABASE_URL,
    future=True,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
