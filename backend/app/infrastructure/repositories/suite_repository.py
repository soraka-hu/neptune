from __future__ import annotations

from functools import lru_cache
from typing import Any

from sqlalchemy import MetaData, Table, func, select, update

from app.infrastructure.db.session import engine
from app.infrastructure.repositories.table_repository import TableRepository


@lru_cache(maxsize=1)
def _suite_table() -> Table:
    metadata = MetaData()
    return Table("suite", metadata, autoload_with=engine)


class SuiteRepository:
    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        table = _suite_table()
        values = dict(payload)
        if "id" in table.c and "id" not in values:
            values["id"] = TableRepository("suite").next_id()
        with engine.begin() as conn:
            result = conn.execute(table.insert().values(**values))
            suite_id = result.inserted_primary_key[0]
        return self.get(suite_id)

    def list(self, project_id: int | None = None, suite_type: str | None = None) -> list[dict[str, Any]]:
        table = _suite_table()
        stmt = select(table).where(table.c.status.notin_(("archived", "deleted")))
        if project_id is not None:
            stmt = stmt.where(table.c.project_id == project_id)
        if suite_type is not None:
            stmt = stmt.where(table.c.suite_type == suite_type)
        with engine.begin() as conn:
            rows = conn.execute(stmt.order_by(table.c.id)).fetchall()
        return [dict(row._mapping) for row in rows]

    def get(self, suite_id: int) -> dict[str, Any] | None:
        table = _suite_table()
        with engine.begin() as conn:
            row = conn.execute(select(table).where(table.c.id == suite_id)).mappings().first()
        return dict(row) if row is not None else None

    def update(self, suite_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        table = _suite_table()
        values = dict(payload)
        if not values:
            return self.get(suite_id)
        values["updated_at"] = func.current_timestamp()
        with engine.begin() as conn:
            result = conn.execute(update(table).where(table.c.id == suite_id).values(**values))
            if result.rowcount == 0:
                return None
        return self.get(suite_id)

    def archive(self, suite_id: int) -> dict[str, Any] | None:
        return self.update(suite_id, {"status": "archived"})
