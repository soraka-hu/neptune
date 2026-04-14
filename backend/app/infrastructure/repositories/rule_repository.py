from __future__ import annotations

from functools import lru_cache
from typing import Any

from sqlalchemy import MetaData, Table, delete, insert, select

from app.infrastructure.db.session import engine
from app.infrastructure.repositories.table_repository import TableRepository


@lru_cache(maxsize=1)
def _rule_project_rel_table() -> Table:
    metadata = MetaData()
    return Table("rule_project_rel", metadata, autoload_with=engine)


@lru_cache(maxsize=1)
def _rule_suite_rel_table() -> Table:
    metadata = MetaData()
    return Table("rule_suite_rel", metadata, autoload_with=engine)


@lru_cache(maxsize=1)
def _project_table() -> Table:
    metadata = MetaData()
    return Table("project", metadata, autoload_with=engine)


@lru_cache(maxsize=1)
def _suite_table() -> Table:
    metadata = MetaData()
    return Table("suite", metadata, autoload_with=engine)


class RuleRepository:
    def __init__(self) -> None:
        self.rule_table = TableRepository("rule_definition")

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.rule_table.create(payload)

    def list(self, rule_type: str | None = None) -> list[dict[str, Any]]:
        return self.rule_table.list({"rule_type": rule_type} if rule_type else None)

    def list_by_ids(
        self,
        rule_ids: list[int],
        *,
        rule_types: list[str] | None = None,
        only_active: bool = True,
    ) -> list[dict[str, Any]]:
        if not rule_ids:
            return []
        id_set = set(int(rule_id) for rule_id in rule_ids)
        allowed_types = set(rule_types or [])
        rules = self.rule_table.list()
        matched: list[dict[str, Any]] = []
        for rule in rules:
            rule_id = int(rule["id"])
            if rule_id not in id_set:
                continue
            if only_active and rule.get("status") != "active":
                continue
            if allowed_types and str(rule.get("rule_type")) not in allowed_types:
                continue
            matched.append(rule)
        return matched

    def get(self, rule_id: int) -> dict[str, Any] | None:
        return self.rule_table.get(rule_id)

    def update(self, rule_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
        return self.rule_table.update(rule_id, payload)

    def delete(self, rule_id: int) -> dict[str, Any] | None:
        return self.rule_table.delete(rule_id)

    def bind_projects(self, rule_id: int, project_ids: list[int]) -> list[int]:
        rel_table = _rule_project_rel_table()
        return self._sync_many_to_many(rel_table, "project_id", rule_id, project_ids)

    def bind_suites(self, rule_id: int, suite_ids: list[int]) -> list[int]:
        rel_table = _rule_suite_rel_table()
        return self._sync_many_to_many(rel_table, "suite_id", rule_id, suite_ids)

    def list_bound_rules(
        self,
        *,
        project_id: int,
        suite_id: int | None,
        rule_types: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        project_rel_table = _rule_project_rel_table()
        suite_rel_table = _rule_suite_rel_table()
        rule_ids: set[int] = set()

        with engine.begin() as conn:
            project_rule_ids = conn.execute(
                select(project_rel_table.c.rule_id).where(project_rel_table.c.project_id == project_id)
            ).scalars().all()
            rule_ids.update(int(rule_id) for rule_id in project_rule_ids)

            if suite_id is not None:
                suite_rule_ids = conn.execute(
                    select(suite_rel_table.c.rule_id).where(suite_rel_table.c.suite_id == suite_id)
                ).scalars().all()
                rule_ids.update(int(rule_id) for rule_id in suite_rule_ids)

        if not rule_ids:
            return []

        allowed_types = set(rule_types or [])
        rules = self.rule_table.list()
        result = []
        for rule in rules:
            if int(rule["id"]) not in rule_ids:
                continue
            if rule.get("status") != "active":
                continue
            if allowed_types and str(rule.get("rule_type")) not in allowed_types:
                continue
            result.append(rule)
        return result

    def list_overview(self, rule_types: list[str] | None = None) -> list[dict[str, Any]]:
        rules = self.rule_table.list()
        if rule_types:
            allowed = set(rule_types)
            rules = [rule for rule in rules if str(rule.get("rule_type")) in allowed]

        relation_map = self._build_relation_map()
        overview_items: list[dict[str, Any]] = []
        for rule in rules:
            relation = relation_map.get(int(rule["id"]), {"project_ids": [], "suite_ids": []})
            overview = dict(rule)
            overview["project_count"] = len(relation["project_ids"])
            overview["suite_count"] = len(relation["suite_ids"])
            overview_items.append(overview)
        return overview_items

    def get_relations(self, rule_id: int) -> dict[str, Any]:
        relation_map = self._build_relation_map()
        relation = relation_map.get(rule_id)
        if relation is None:
            projects_by_id, suites_by_id = self._load_project_and_suite_maps()
            relation = {
                "project_ids": [],
                "suite_ids": [],
                "projects_by_id": projects_by_id,
                "suites_by_id": suites_by_id,
            }

        project_ids = relation["project_ids"]
        suite_ids = relation["suite_ids"]
        projects_by_id = relation["projects_by_id"]
        suites_by_id = relation["suites_by_id"]

        projects = [
            {
                "id": project_id,
                "name": projects_by_id.get(project_id, {}).get("name", f"project-{project_id}"),
                "status": projects_by_id.get(project_id, {}).get("status"),
                "source": "rule_binding",
            }
            for project_id in project_ids
        ]

        suites = []
        for suite_id in suite_ids:
            suite = suites_by_id.get(suite_id, {})
            project_id = suite.get("project_id")
            suites.append(
                {
                    "id": suite_id,
                    "name": suite.get("name", f"suite-{suite_id}"),
                    "status": suite.get("status"),
                    "project_id": project_id,
                    "project_name": projects_by_id.get(project_id, {}).get("name") if project_id is not None else None,
                    "source": "rule_binding",
                }
            )

        return {
            "rule_id": rule_id,
            "project_ids": project_ids,
            "suite_ids": suite_ids,
            "project_count": len(project_ids),
            "suite_count": len(suite_ids),
            "projects": projects,
            "suites": suites,
        }

    def _sync_many_to_many(
        self,
        rel_table: Table,
        column_name: str,
        rule_id: int,
        target_ids: list[int],
    ) -> list[int]:
        unique_ids = [target_id for target_id in dict.fromkeys(target_ids)]
        with engine.begin() as conn:
            existing_rows = conn.execute(
                select(rel_table.c[column_name]).where(rel_table.c.rule_id == rule_id)
            ).scalars().all()
            existing_ids = set(existing_rows)
            target_id_set = set(unique_ids)

            stale_ids = existing_ids - target_id_set
            if stale_ids:
                conn.execute(
                    delete(rel_table).where(
                        rel_table.c.rule_id == rule_id,
                        rel_table.c[column_name].in_(stale_ids),
                    )
                )

            for target_id in unique_ids:
                if target_id in existing_ids:
                    continue
                next_id = TableRepository(rel_table.name).next_id()
                conn.execute(insert(rel_table).values(id=next_id, rule_id=rule_id, **{column_name: target_id}))
        return unique_ids

    def _build_relation_map(self) -> dict[int, dict[str, Any]]:
        project_rel_table = _rule_project_rel_table()
        suite_rel_table = _rule_suite_rel_table()
        projects_by_id, suites_by_id = self._load_project_and_suite_maps()

        with engine.begin() as conn:
            project_rel_rows = conn.execute(
                select(project_rel_table.c.rule_id, project_rel_table.c.project_id).order_by(project_rel_table.c.id)
            ).fetchall()
            suite_rel_rows = conn.execute(
                select(suite_rel_table.c.rule_id, suite_rel_table.c.suite_id).order_by(suite_rel_table.c.id)
            ).fetchall()

        relation_map: dict[int, dict[str, Any]] = {}

        for row in project_rel_rows:
            bucket = relation_map.setdefault(
                int(row.rule_id),
                {
                    "project_ids": [],
                    "suite_ids": [],
                    "projects_by_id": projects_by_id,
                    "suites_by_id": suites_by_id,
                },
            )
            project_id = int(row.project_id)
            if project_id not in bucket["project_ids"]:
                bucket["project_ids"].append(project_id)

        for row in suite_rel_rows:
            bucket = relation_map.setdefault(
                int(row.rule_id),
                {
                    "project_ids": [],
                    "suite_ids": [],
                    "projects_by_id": projects_by_id,
                    "suites_by_id": suites_by_id,
                },
            )
            suite_id = int(row.suite_id)
            if suite_id not in bucket["suite_ids"]:
                bucket["suite_ids"].append(suite_id)

        return relation_map

    def _load_project_and_suite_maps(self) -> tuple[dict[int, dict[str, Any]], dict[int, dict[str, Any]]]:
        project_table = _project_table()
        suite_table = _suite_table()
        with engine.begin() as conn:
            project_rows = conn.execute(
                select(project_table.c.id, project_table.c.name, project_table.c.status)
            ).fetchall()
            suite_rows = conn.execute(
                select(suite_table.c.id, suite_table.c.name, suite_table.c.project_id, suite_table.c.status)
            ).fetchall()

        projects_by_id = {
            int(row.id): {"name": row.name, "status": row.status}
            for row in project_rows
        }
        suites_by_id = {
            int(row.id): {"name": row.name, "project_id": row.project_id, "status": row.status}
            for row in suite_rows
        }
        return projects_by_id, suites_by_id
