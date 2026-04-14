from __future__ import annotations

from functools import lru_cache
from typing import Any

from sqlalchemy import MetaData, Table, func, select, update

from app.infrastructure.db.session import engine
from app.infrastructure.repositories.table_repository import TableRepository


@lru_cache(maxsize=1)
def _case_table() -> Table:
    metadata = MetaData()
    return Table("case_item", metadata, autoload_with=engine)


class CaseRepository:
    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        table = _case_table()
        values = dict(payload)
        if "id" in table.c and "id" not in values:
            values["id"] = TableRepository("case_item").next_id()
        with engine.begin() as conn:
            result = conn.execute(table.insert().values(**values))
            case_id = result.inserted_primary_key[0]
        return self.get(case_id)

    def list(
        self,
        project_id: int | None = None,
        suite_id: int | None = None,
        case_type: str | None = None,
    ) -> list[dict[str, Any]]:
        table = _case_table()
        stmt = select(table).where(table.c.status.notin_(("archived", "deleted")))
        if project_id is not None:
            stmt = stmt.where(table.c.project_id == project_id)
        if suite_id is not None:
            stmt = stmt.where(table.c.suite_id == suite_id)
        if case_type is not None:
            stmt = stmt.where(table.c.case_type == case_type)
        with engine.begin() as conn:
            rows = conn.execute(stmt.order_by(table.c.id)).fetchall()
        return [dict(row._mapping) for row in rows]

    def get(self, case_id: int) -> dict[str, Any] | None:
        table = _case_table()
        with engine.begin() as conn:
            row = conn.execute(select(table).where(table.c.id == case_id)).mappings().first()
        return dict(row) if row is not None else None

    def update(self, case_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        table = _case_table()
        values = dict(payload)
        if not values:
            return self.get(case_id)
        values["updated_at"] = func.current_timestamp()
        with engine.begin() as conn:
            result = conn.execute(update(table).where(table.c.id == case_id).values(**values))
            if result.rowcount == 0:
                return None
        return self.get(case_id)

    def archive(self, case_id: int) -> dict[str, Any] | None:
        return self.update(case_id, {"status": "archived"})

    def archive_by_suite(self, suite_id: int) -> int:
        table = _case_table()
        with engine.begin() as conn:
            result = conn.execute(
                update(table)
                .where(table.c.suite_id == suite_id)
                .where(table.c.status.notin_(("archived", "deleted")))
                .values(status="archived", updated_at=func.current_timestamp())
            )
        return int(result.rowcount or 0)

    def duplicate(self, case_id: int) -> dict[str, Any] | None:
        source = self.get(case_id)
        if source is None:
            return None
        clone = dict(source)
        clone.pop("id", None)
        clone["name"] = f"{source['name']} Copy"
        clone["version"] = int(source.get("version") or 1) + 1
        clone["status"] = "draft"
        clone.pop("created_at", None)
        clone.pop("updated_at", None)
        return self.create(clone)
