from __future__ import annotations

from functools import lru_cache
from typing import Any

from sqlalchemy import MetaData, Table, delete, func, insert, select, update

from app.infrastructure.db.session import engine


@lru_cache(maxsize=None)
def _reflect_table(table_name: str) -> Table:
    metadata = MetaData()
    return Table(table_name, metadata, autoload_with=engine)


class TableRepository:
    def __init__(self, table_name: str) -> None:
        self.table_name = table_name

    @property
    def table(self) -> Table:
        return _reflect_table(self.table_name)

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        values = dict(payload)
        if "id" in self.table.c and "id" not in values:
            values["id"] = self.next_id()
        with engine.begin() as conn:
            result = conn.execute(insert(self.table).values(**values))
            record_id = result.inserted_primary_key[0]
        return self.get(record_id) or {}

    def next_id(self) -> int:
        stmt = select(func.coalesce(func.max(self.table.c.id), 0) + 1)
        with engine.begin() as conn:
            return int(conn.execute(stmt).scalar_one())

    def list(self, filters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        stmt = select(self.table)
        effective_filters = dict(filters or {})
        if "status" in self.table.c and "status" not in effective_filters:
            stmt = stmt.where(self.table.c.status.notin_(("archived", "deleted")))
        for key, value in effective_filters.items():
            if value is None or key not in self.table.c:
                continue
            stmt = stmt.where(self.table.c[key] == value)
        with engine.begin() as conn:
            rows = conn.execute(stmt.order_by(self.table.c.id)).fetchall()
        return [dict(row._mapping) for row in rows]

    def get(self, record_id: int) -> dict[str, Any] | None:
        with engine.begin() as conn:
            row = conn.execute(select(self.table).where(self.table.c.id == record_id)).mappings().first()
        return dict(row) if row is not None else None

    def update(self, record_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        values = dict(payload)
        if not values:
            return self.get(record_id)
        if "updated_at" in self.table.c:
            values["updated_at"] = func.current_timestamp()
        with engine.begin() as conn:
            result = conn.execute(update(self.table).where(self.table.c.id == record_id).values(**values))
            if result.rowcount == 0:
                return None
        return self.get(record_id)

    def delete(self, record_id: int) -> dict[str, Any] | None:
        if "status" in self.table.c:
            return self.update(record_id, {"status": "archived"})
        with engine.begin() as conn:
            result = conn.execute(delete(self.table).where(self.table.c.id == record_id))
        return {} if result.rowcount > 0 else None
