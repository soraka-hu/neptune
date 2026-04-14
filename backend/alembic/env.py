from __future__ import annotations

from logging.config import fileConfig
import os
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

from app.infrastructure.db.base import Base


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)


def _default_sqlite_url() -> str:
    runtime_dir = Path(__file__).resolve().parents[1] / ".runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite+pysqlite:///{runtime_dir / 'unified_test_eval.sqlite3'}"


target_metadata = Base.metadata


def get_database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    return _default_sqlite_url()


def run_migrations_offline() -> None:
    url = get_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(get_database_url(), poolclass=pool.NullPool, future=True)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
