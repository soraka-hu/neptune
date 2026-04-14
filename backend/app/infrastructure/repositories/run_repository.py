from __future__ import annotations

from functools import lru_cache
from typing import Any
from uuid import uuid4

from sqlalchemy import MetaData, String, Table, cast, func, not_, or_, select, update

from app.infrastructure.db.session import engine


@lru_cache(maxsize=1)
def _run_table() -> Table:
    metadata = MetaData()
    return Table("run_record", metadata, autoload_with=engine)


class RunRepository:
    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        table = _run_table()
        values = dict(payload)
        if not values.get("run_no"):
            values["run_no"] = self._generate_run_no(values.get("run_type", "run"))
        if "id" not in values:
            values["id"] = self.next_id()
        with engine.begin() as conn:
            existing = conn.execute(
                select(table).where(table.c.idempotency_key == values["idempotency_key"])
            ).mappings().first()
            if existing is not None:
                return dict(existing)
            conn.execute(table.insert().values(**values))
        return self.get(values["id"]) or {}

    def list(
        self,
        project_id: int | None = None,
        suite_id: int | None = None,
        status: str | None = None,
        run_type: str | None = None,
    ) -> list[dict[str, Any]]:
        table = _run_table()

        # 兼容两种软删除方案：
        # 1) 新版本：run_record.is_deleted = true
        # 2) 旧版本：summary JSON 含 "_deleted": true
        where_clauses = []
        if "is_deleted" in table.c:
            where_clauses.append(or_(table.c.is_deleted.is_(None), table.c.is_deleted.is_(False)))

        summary_text = cast(table.c.summary, String)
        where_clauses.append(or_(table.c.summary.is_(None), not_(summary_text.like('%"_deleted": true%'))))

        stmt = select(table)
        for clause in where_clauses:
            stmt = stmt.where(clause)
        if project_id is not None:
            stmt = stmt.where(table.c.project_id == project_id)
        if suite_id is not None:
            stmt = stmt.where(table.c.suite_id == suite_id)
        if status is not None:
            stmt = stmt.where(table.c.status == status)
        if run_type is not None:
            stmt = stmt.where(table.c.run_type == run_type)
        with engine.begin() as conn:
            rows = conn.execute(stmt.order_by(table.c.id)).fetchall()
        return [dict(row._mapping) for row in rows]

    def get(self, run_id: int) -> dict[str, Any] | None:
        table = _run_table()
        with engine.begin() as conn:
            row = conn.execute(select(table).where(table.c.id == run_id)).mappings().first()
        return dict(row) if row is not None else None

    def get_by_idempotency_key(self, idempotency_key: str) -> dict[str, Any] | None:
        table = _run_table()
        with engine.begin() as conn:
            row = conn.execute(select(table).where(table.c.idempotency_key == idempotency_key)).mappings().first()
        return dict(row) if row is not None else None

    def update(self, run_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        table = _run_table()
        values = {key: value for key, value in dict(payload).items() if key in table.c}
        if not values:
            return self.get(run_id)
        if "updated_at" in table.c:
            values["updated_at"] = func.current_timestamp()
        with engine.begin() as conn:
            result = conn.execute(update(table).where(table.c.id == run_id).values(**values))
            if result.rowcount == 0:
                return None
        return self.get(run_id)

    def next_id(self) -> int:
        table = _run_table()
        stmt = select(func.coalesce(func.max(table.c.id), 0) + 1)
        with engine.begin() as conn:
            return int(conn.execute(stmt).scalar_one())

    @staticmethod
    def _generate_run_no(run_type: str) -> str:
        normalized = "".join(ch.lower() if ch.isalnum() else "-" for ch in run_type).strip("-") or "run"
        return f"{normalized[:16]}-{uuid4().hex[:12]}"
