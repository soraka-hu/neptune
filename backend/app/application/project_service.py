from __future__ import annotations

from uuid import uuid4

from app.infrastructure.repositories.project_repository import ProjectRepository


class NotFoundError(LookupError):
    pass


class ProjectService:
    def __init__(self, repository: ProjectRepository | None = None) -> None:
        self.repository = repository or ProjectRepository()

    def create_project(self, payload: dict) -> dict:
        name = payload["name"].strip()
        record = {
            "project_key": self._generate_project_key(name),
            "name": name,
            "description": payload.get("description"),
            "project_type": payload["project_type"],
            "status": payload.get("status", "active"),
            "owner_id": payload.get("owner_id"),
            "created_by": payload.get("created_by"),
            "updated_by": payload.get("updated_by"),
        }
        return self.repository.create(record)

    def list_projects(self) -> list[dict]:
        return self.repository.list()

    def get_project(self, project_id: int) -> dict:
        record = self.repository.get(project_id)
        if record is None:
            raise NotFoundError(f"project {project_id} not found")
        return record

    def update_project(self, project_id: int, payload: dict) -> dict:
        record = self.repository.update(project_id, payload)
        if record is None:
            raise NotFoundError(f"project {project_id} not found")
        return record

    def archive_project(self, project_id: int) -> dict:
        record = self.repository.update(project_id, {"status": "archived"})
        if record is None:
            raise NotFoundError(f"project {project_id} not found")
        return record

    @staticmethod
    def _generate_project_key(name: str) -> str:
        normalized = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")
        normalized = "-".join(part for part in normalized.split("-") if part) or "project"
        suffix = uuid4().hex[:8]
        key = f"{normalized[:48]}-{suffix}"
        return key[:64]
