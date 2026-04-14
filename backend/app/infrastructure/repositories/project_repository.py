from __future__ import annotations

from functools import lru_cache
from typing import Any

from sqlalchemy import MetaData, Table, delete, func, select, update

from app.infrastructure.db.session import engine
from app.infrastructure.repositories.table_repository import TableRepository


@lru_cache(maxsize=1)
def _project_table() -> Table:
    metadata = MetaData()
    return Table("project", metadata, autoload_with=engine)


class ProjectRepository:
    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        table = _project_table()
        values = dict(payload)
        if "id" in table.c and "id" not in values:
            values["id"] = TableRepository("project").next_id()
        with engine.begin() as conn:
            result = conn.execute(table.insert().values(**values))
            project_id = result.inserted_primary_key[0]
        return self.get(project_id)

    def list(self) -> list[dict[str, Any]]:
        table = _project_table()
        stmt = select(table).where(table.c.status.notin_(("archived", "deleted")))
        with engine.begin() as conn:
            rows = conn.execute(stmt.order_by(table.c.id)).fetchall()
        return [dict(row._mapping) for row in rows]

    def get(self, project_id: int) -> dict[str, Any] | None:
        table = _project_table()
        with engine.begin() as conn:
            row = conn.execute(select(table).where(table.c.id == project_id)).mappings().first()
        return dict(row) if row is not None else None

    def update(self, project_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        table = _project_table()
        values = dict(payload)
        if not values:
            return self.get(project_id)
        values["updated_at"] = func.current_timestamp()
        with engine.begin() as conn:
            result = conn.execute(update(table).where(table.c.id == project_id).values(**values))
            if result.rowcount == 0:
                return None
        return self.get(project_id)

    def delete(self, project_id: int) -> bool:
        table = _project_table()
        with engine.begin() as conn:
            result = conn.execute(delete(table).where(table.c.id == project_id))
        return result.rowcount > 0
