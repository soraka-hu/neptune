from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from typing import Any

from sqlalchemy import MetaData, Table, func, select, update

from app.infrastructure.db.session import engine


@lru_cache(maxsize=1)
def _run_schedule_table() -> Table:
    metadata = MetaData()
    return Table("run_schedule", metadata, autoload_with=engine)


class RunScheduleRepository:
    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        table = _run_schedule_table()
        values = dict(payload)
        if "id" not in values:
            values["id"] = self.next_id()
        with engine.begin() as conn:
            conn.execute(table.insert().values(**values))
        return self.get(values["id"]) or {}

    def list(
        self,
        *,
        project_id: int | None = None,
        suite_id: int | None = None,
        status: str | None = None,
        run_type: str | None = None,
    ) -> list[dict[str, Any]]:
        table = _run_schedule_table()
        stmt = select(table).where(table.c.status != "archived")
        if project_id is not None:
            stmt = stmt.where(table.c.project_id == project_id)
        if suite_id is not None:
            stmt = stmt.where(table.c.suite_id == suite_id)
        if status is not None:
            stmt = stmt.where(table.c.status == status)
        if run_type is not None:
            stmt = stmt.where(table.c.run_type == run_type)
        with engine.begin() as conn:
            rows = conn.execute(stmt.order_by(table.c.next_run_at, table.c.id)).fetchall()
        return [dict(row._mapping) for row in rows]

    def list_due(self, *, now: datetime, limit: int = 20) -> list[dict[str, Any]]:
        table = _run_schedule_table()
        stmt = (
            select(table)
            .where(table.c.status == "active")
            .where(table.c.next_run_at <= now)
            .order_by(table.c.next_run_at, table.c.id)
            .limit(max(1, limit))
        )
        with engine.begin() as conn:
            rows = conn.execute(stmt).fetchall()
        return [dict(row._mapping) for row in rows]

    def claim_due(
        self,
        schedule_id: int,
        *,
        expected_next_run_at: datetime,
        now: datetime,
        next_run_at: datetime,
    ) -> bool:
        table = _run_schedule_table()
        values: dict[str, Any] = {
            "last_run_at": now,
            "next_run_at": next_run_at,
            "trigger_count": func.coalesce(table.c.trigger_count, 0) + 1,
        }
        if "updated_at" in table.c:
            values["updated_at"] = func.current_timestamp()
        stmt = (
            update(table)
            .where(table.c.id == schedule_id)
            .where(table.c.status == "active")
            .where(table.c.next_run_at == expected_next_run_at)
            .where(table.c.next_run_at <= now)
            .values(**values)
        )
        with engine.begin() as conn:
            result = conn.execute(stmt)
        return bool(result.rowcount and result.rowcount > 0)

    def get(self, schedule_id: int) -> dict[str, Any] | None:
        table = _run_schedule_table()
        with engine.begin() as conn:
            row = conn.execute(select(table).where(table.c.id == schedule_id)).mappings().first()
        return dict(row) if row is not None else None

    def update(self, schedule_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        table = _run_schedule_table()
        values = {key: value for key, value in dict(payload).items() if key in table.c}
        if not values:
            return self.get(schedule_id)
        if "updated_at" in table.c:
            values["updated_at"] = func.current_timestamp()
        with engine.begin() as conn:
            result = conn.execute(update(table).where(table.c.id == schedule_id).values(**values))
            if result.rowcount == 0:
                return None
        return self.get(schedule_id)

    def archive(self, schedule_id: int) -> dict[str, Any] | None:
        return self.update(schedule_id, {"status": "archived"})

    def next_id(self) -> int:
        table = _run_schedule_table()
        stmt = select(func.coalesce(func.max(table.c.id), 0) + 1)
        with engine.begin() as conn:
            return int(conn.execute(stmt).scalar_one())
