from __future__ import annotations

import base64
import binascii
import io
import zipfile
from xml.etree import ElementTree as ET
from typing import Any

from app.application.project_service import NotFoundError
from app.domain.services.schema_registry_service import CaseSchemaRegistry
from app.infrastructure.repositories.case_repository import CaseRepository
from app.infrastructure.repositories.suite_repository import SuiteRepository
from app.infrastructure.repositories.table_repository import TableRepository


SUPPORTED_REPORT_CHANNEL_TYPES = {"feishu_app"}


class AssetService:
    def __init__(
        self,
        suite_repository: SuiteRepository | None = None,
        case_repository: CaseRepository | None = None,
        dataset_repository: TableRepository | None = None,
        evaluator_repository: TableRepository | None = None,
        environment_repository: TableRepository | None = None,
        prompt_repository: TableRepository | None = None,
        dataset_item_repository: TableRepository | None = None,
        user_asset_repository: TableRepository | None = None,
    ) -> None:
        self.suite_repository = suite_repository or SuiteRepository()
        self.case_repository = case_repository or CaseRepository()
        self.dataset_repository = dataset_repository or TableRepository("dataset")
        self.evaluator_repository = evaluator_repository or TableRepository("evaluator")
        self.environment_repository = environment_repository or TableRepository("environment")
        self.prompt_repository = prompt_repository or TableRepository("prompt_template")
        self.dataset_item_repository = dataset_item_repository or TableRepository("dataset_item")
        self.user_asset_repository = user_asset_repository or TableRepository("user_asset")

    def create_suite(self, payload: dict) -> dict:
        return self.suite_repository.create(payload)

    def list_suites(self, project_id: int | None = None, suite_type: str | None = None) -> list[dict]:
        return self.suite_repository.list(project_id=project_id, suite_type=suite_type)

    def list_suite_asset_overview(self, project_id: int, case_type: str) -> list[dict]:
        normalized_case_type = "agent" if case_type == "agent" else "api"
        suites = self.suite_repository.list(project_id=project_id)
        cases = self.case_repository.list(project_id=project_id, case_type=normalized_case_type)
        user_assets = self.user_asset_repository.list({"project_id": project_id})

        case_count_by_suite: dict[int, int] = {}
        source_types_by_suite: dict[int, set[str]] = {}
        case_updated_at_by_suite: dict[int, str] = {}
        for case in cases:
            suite_id = self._as_int(case.get("suite_id"))
            if suite_id is None:
                continue
            case_count_by_suite[suite_id] = case_count_by_suite.get(suite_id, 0) + 1
            source_type = str(case.get("source_type") or "manual")
            source_types_by_suite.setdefault(suite_id, set()).add(source_type)
            updated_at = str(case.get("updated_at") or "")
            if updated_at and updated_at > case_updated_at_by_suite.get(suite_id, ""):
                case_updated_at_by_suite[suite_id] = updated_at

        doc_name_by_id: dict[int, str] = {}
        for asset in user_assets:
            if asset.get("asset_type") not in {"prd_agent_doc", "api_doc"}:
                continue
            asset_id = self._as_int(asset.get("id"))
            if asset_id is None:
                continue
            doc_name_by_id[asset_id] = str(asset.get("name") or f"doc-{asset_id}")

        batch_asset_type = "agent_dataset_generation_batch" if normalized_case_type == "agent" else "api_case_generation_batch"
        latest_batch_by_suite: dict[int, dict[str, Any]] = {}
        for asset in user_assets:
            if asset.get("asset_type") != batch_asset_type:
                continue
            content = asset.get("content_json")
            meta = asset.get("meta_info")
            suite_id = self._as_int(
                (content.get("suite_id") if isinstance(content, dict) else None)
                or (meta.get("suite_id") if isinstance(meta, dict) else None)
                or asset.get("suite_id")
            )
            if suite_id is None:
                continue
            current = latest_batch_by_suite.get(suite_id)
            current_created_at = str(current.get("created_at") or "") if current is not None else ""
            created_at = str(asset.get("created_at") or "")
            if created_at > current_created_at:
                latest_batch_by_suite[suite_id] = asset

        matched_suite_ids = {
            suite["id"]
            for suite in suites
            if self._suite_matches_case_type(str(suite.get("suite_type") or ""), normalized_case_type)
        }
        matched_suite_ids.update(case_count_by_suite.keys())
        matched_suite_ids.update(latest_batch_by_suite.keys())

        suite_by_id = {int(suite["id"]): suite for suite in suites}
        overview_items: list[dict[str, Any]] = []
        for suite_id in sorted(matched_suite_ids):
            suite = suite_by_id.get(suite_id)
            if suite is None:
                continue
            latest_batch = latest_batch_by_suite.get(suite_id)
            batch_content = latest_batch.get("content_json") if isinstance(latest_batch, dict) else {}
            if not isinstance(batch_content, dict):
                batch_content = {}
            source_types = source_types_by_suite.get(suite_id, set())
            source_summary = ",".join(sorted(source_types)) if source_types else "-"
            if "llm_generated" in source_types:
                source_summary = "llm_generated"

            linked_prd_doc_id = self._as_int(batch_content.get("prd_doc_id"))
            linked_api_doc_id = self._as_int(batch_content.get("api_doc_id"))
            linked_source_doc_id = self._as_int(batch_content.get("source_doc_id"))

            overview_items.append(
                {
                    "id": suite["id"],
                    "project_id": suite["project_id"],
                    "name": suite["name"],
                    "suite_type": suite["suite_type"],
                    "status": suite["status"],
                    "updated_at": suite.get("updated_at"),
                    "case_type": normalized_case_type,
                    "case_count": case_count_by_suite.get(suite_id, 0),
                    "source_summary": source_summary,
                    "last_generated_at": latest_batch.get("created_at") if isinstance(latest_batch, dict) else None,
                    "last_generation_batch_id": batch_content.get("batch_id"),
                    "last_case_updated_at": case_updated_at_by_suite.get(suite_id),
                    "linked_prd_doc_id": linked_prd_doc_id,
                    "linked_prd_doc_name": doc_name_by_id.get(linked_prd_doc_id) if linked_prd_doc_id is not None else None,
                    "linked_api_doc_id": linked_api_doc_id,
                    "linked_api_doc_name": doc_name_by_id.get(linked_api_doc_id) if linked_api_doc_id is not None else None,
                    "linked_source_doc_id": linked_source_doc_id,
                    "linked_source_doc_name": doc_name_by_id.get(linked_source_doc_id) if linked_source_doc_id is not None else None,
                    "generation_method": "llm" if latest_batch is not None else None,
                }
            )

        overview_items.sort(
            key=lambda item: (
                str(item.get("last_generated_at") or ""),
                str(item.get("last_case_updated_at") or ""),
                str(item.get("updated_at") or ""),
                int(item.get("id") or 0),
            ),
            reverse=True,
        )
        return overview_items

    def get_suite(self, suite_id: int) -> dict:
        record = self.suite_repository.get(suite_id)
        if record is None:
            raise NotFoundError(f"suite {suite_id} not found")
        return record

    def update_suite(self, suite_id: int, payload: dict) -> dict:
        record = self.suite_repository.update(suite_id, payload)
        if record is None:
            raise NotFoundError(f"suite {suite_id} not found")
        return record

    def delete_suite(self, suite_id: int) -> dict:
        existing = self.suite_repository.get(suite_id)
        if existing is None:
            raise NotFoundError(f"suite {suite_id} not found")

        archived_case_count = self.case_repository.archive_by_suite(suite_id)
        record = self.suite_repository.archive(suite_id)
        if record is None:
            raise NotFoundError(f"suite {suite_id} not found")

        payload = dict(record)
        payload["archived_case_count"] = archived_case_count
        return payload

    def create_case(self, payload: dict) -> dict:
        CaseSchemaRegistry.validate_input_payload(payload["case_type"], payload["input_payload"])
        expected_output = payload.get("expected_output")
        if expected_output is not None:
            schema_key = self._detect_expected_output_schema(expected_output)
            CaseSchemaRegistry.validate_expected_output(schema_key, expected_output)

        eval_config = payload.get("eval_config")
        if eval_config is not None:
            CaseSchemaRegistry.validate_eval_config(eval_config)

        return self.case_repository.create(payload)

    def list_cases(
        self,
        project_id: int | None = None,
        suite_id: int | None = None,
        case_type: str | None = None,
    ) -> list[dict]:
        return self.case_repository.list(project_id=project_id, suite_id=suite_id, case_type=case_type)

    def get_case(self, case_id: int) -> dict:
        record = self.case_repository.get(case_id)
        if record is None:
            raise NotFoundError(f"case {case_id} not found")
        return record

    def update_case(self, case_id: int, payload: dict) -> dict:
        if "input_payload" in payload and "case_type" in payload:
            CaseSchemaRegistry.validate_input_payload(payload["case_type"], payload["input_payload"])
        record = self.case_repository.update(case_id, payload)
        if record is None:
            raise NotFoundError(f"case {case_id} not found")
        return record

    def delete_case(self, case_id: int) -> dict:
        record = self.case_repository.archive(case_id)
        if record is None:
            raise NotFoundError(f"case {case_id} not found")
        return record

    def duplicate_case(self, case_id: int) -> dict:
        record = self.case_repository.duplicate(case_id)
        if record is None:
            raise NotFoundError(f"case {case_id} not found")
        return record

    def change_case_status(self, case_id: int, status: str) -> dict:
        record = self.case_repository.update(case_id, {"status": status})
        if record is None:
            raise NotFoundError(f"case {case_id} not found")
        return record

    def create_dataset(self, payload: dict) -> dict:
        return self.dataset_repository.create(payload)

    def list_datasets(self, project_id: int | None = None) -> list[dict]:
        records = self.dataset_repository.list({"project_id": project_id} if project_id is not None else None)
        return [record for record in records if not self._is_soft_deleted(record)]

    def get_dataset(self, dataset_id: int) -> dict:
        record = self.dataset_repository.get(dataset_id)
        if record is None:
            raise NotFoundError(f"dataset {dataset_id} not found")
        return record

    def update_dataset(self, dataset_id: int, payload: dict) -> dict:
        record = self.dataset_repository.update(dataset_id, payload)
        if record is None:
            raise NotFoundError(f"dataset {dataset_id} not found")
        return record

    def delete_dataset(self, dataset_id: int) -> dict:
        record = self.dataset_repository.delete(dataset_id)
        if record is None:
            raise NotFoundError(f"dataset {dataset_id} not found")
        return record

    def add_dataset_item(self, dataset_id: int, payload: dict) -> dict:
        return self.dataset_item_repository.create({"dataset_id": dataset_id, **payload})

    def import_dataset_items(self, dataset_id: int, items: list[dict]) -> dict:
        created = [self.add_dataset_item(dataset_id, item) for item in items]
        return {"items": created, "total": len(created)}

    def delete_dataset_item(self, item_id: int) -> dict:
        record = self.dataset_item_repository.delete(item_id)
        if record is None:
            raise NotFoundError(f"dataset item {item_id} not found")
        return record

    def create_evaluator(self, payload: dict) -> dict:
        return self.evaluator_repository.create(payload)

    def list_evaluators(self) -> list[dict]:
        return self.evaluator_repository.list()

    def get_evaluator(self, evaluator_id: int) -> dict:
        record = self.evaluator_repository.get(evaluator_id)
        if record is None:
            raise NotFoundError(f"evaluator {evaluator_id} not found")
        return record

    def update_evaluator(self, evaluator_id: int, payload: dict) -> dict:
        record = self.evaluator_repository.update(evaluator_id, payload)
        if record is None:
            raise NotFoundError(f"evaluator {evaluator_id} not found")
        return record

    def delete_evaluator(self, evaluator_id: int) -> dict:
        record = self.evaluator_repository.delete(evaluator_id)
        if record is None:
            raise NotFoundError(f"evaluator {evaluator_id} not found")
        return record

    def create_environment(self, payload: dict) -> dict:
        return self.environment_repository.create(payload)

    def list_environments(self, project_id: int | None = None) -> list[dict]:
        return self.environment_repository.list({"project_id": project_id} if project_id is not None else None)

    def get_environment(self, environment_id: int) -> dict:
        record = self.environment_repository.get(environment_id)
        if record is None:
            raise NotFoundError(f"environment {environment_id} not found")
        return record

    def update_environment(self, environment_id: int, payload: dict) -> dict:
        record = self.environment_repository.update(environment_id, payload)
        if record is None:
            raise NotFoundError(f"environment {environment_id} not found")
        return record

    def delete_environment(self, environment_id: int) -> dict:
        record = self.environment_repository.delete(environment_id)
        if record is None:
            raise NotFoundError(f"environment {environment_id} not found")
        return record

    def create_prompt_template(self, payload: dict) -> dict:
        return self.prompt_repository.create(payload)

    def list_prompt_templates(self) -> list[dict]:
        return self.prompt_repository.list()

    def get_prompt_template(self, prompt_id: int) -> dict:
        record = self.prompt_repository.get(prompt_id)
        if record is None:
            raise NotFoundError(f"prompt template {prompt_id} not found")
        return record

    def update_prompt_template(self, prompt_id: int, payload: dict) -> dict:
        record = self.prompt_repository.update(prompt_id, payload)
        if record is None:
            raise NotFoundError(f"prompt template {prompt_id} not found")
        return record

    def delete_prompt_template(self, prompt_id: int) -> dict:
        record = self.prompt_repository.delete(prompt_id)
        if record is None:
            raise NotFoundError(f"prompt template {prompt_id} not found")
        return record

    def create_user_asset(self, payload: dict) -> dict:
        normalized_payload = dict(payload)
        file_base64 = normalized_payload.pop("file_base64", None)
        asset_type = str(normalized_payload.get("asset_type") or "")
        file_name = str(normalized_payload.get("file_name") or "").lower()

        if asset_type == "prd_agent_doc" and file_name.endswith(".docx"):
            if isinstance(file_base64, str) and file_base64.strip():
                normalized_payload["content_text"] = self._extract_docx_text(file_base64)
            else:
                content_text = normalized_payload.get("content_text")
                if not isinstance(content_text, str) or not content_text.strip():
                    raise ValueError("Word 文档缺少可解析内容，请重新上传 .docx 文件")
        if asset_type == "report_channel":
            normalized_payload["content_json"] = self._normalize_report_channel_content(normalized_payload.get("content_json"))

        return self.user_asset_repository.create(normalized_payload)

    def list_user_assets(
        self,
        project_id: int | None = None,
        suite_id: int | None = None,
        asset_type: str | None = None,
        status: str | None = None,
    ) -> list[dict]:
        filters: dict[str, int | str] = {}
        if project_id is not None:
            filters["project_id"] = project_id
        if suite_id is not None:
            filters["suite_id"] = suite_id
        if asset_type is not None:
            filters["asset_type"] = asset_type
        if status is not None:
            filters["status"] = status
        return self.user_asset_repository.list(filters or None)

    def get_user_asset(self, asset_id: int) -> dict:
        record = self.user_asset_repository.get(asset_id)
        if record is None:
            raise NotFoundError(f"user asset {asset_id} not found")
        return record

    def update_user_asset(self, asset_id: int, payload: dict) -> dict:
        existing = self.user_asset_repository.get(asset_id)
        if existing is None:
            raise NotFoundError(f"user asset {asset_id} not found")
        normalized_payload = dict(payload)
        merged_asset_type = str(normalized_payload.get("asset_type") or existing.get("asset_type") or "")
        if merged_asset_type == "report_channel":
            content_json = normalized_payload.get("content_json")
            if not isinstance(content_json, dict):
                content_json = existing.get("content_json")
            normalized_payload["content_json"] = self._normalize_report_channel_content(content_json)

        record = self.user_asset_repository.update(asset_id, normalized_payload)
        if record is None:
            raise NotFoundError(f"user asset {asset_id} not found")
        return record

    def delete_user_asset(self, asset_id: int) -> dict:
        record = self.user_asset_repository.get(asset_id)
        if record is None:
            raise NotFoundError(f"user asset {asset_id} not found")

        asset_type = str(record.get("asset_type") or "")
        if asset_type in {"agent_dataset_generation_batch", "api_case_generation_batch"}:
            content = record.get("content_json")
            if isinstance(content, dict):
                case_ids: set[int] = set()
                case_ids.update(self._extract_case_ids(content.get("created_case_ids")))
                case_ids.update(self._extract_case_ids(content.get("case_ids")))
                case_ids.update(self._extract_case_ids(content.get("generated_api_case_ids")))
                case_ids.update(self._extract_case_ids(content.get("api_case_ids")))

                for case_id in sorted(case_ids):
                    # 统一用“删除 case”的语义：归档 case，避免硬删除影响外键/报表等。
                    self.case_repository.archive(case_id)

                # Agent 数据集批次删除时，同时归档关联 dataset 与 dataset_item，避免执行发起页仍显示“孤儿数据集”。
                if asset_type == "agent_dataset_generation_batch":
                    dataset_ids = self._extract_case_ids(content.get("dataset_id"))
                    for dataset_id in dataset_ids:
                        dataset_record = self.dataset_repository.get(dataset_id)
                        if dataset_record is not None:
                            self.dataset_repository.update(dataset_id, {"status": "archived"})

                        dataset_items = self.dataset_item_repository.list({"dataset_id": dataset_id})
                        for item in dataset_items:
                            item_id = item.get("id")
                            if isinstance(item_id, int):
                                self.dataset_item_repository.update(item_id, {"status": "archived"})

        deleted = self.user_asset_repository.delete(asset_id)
        if deleted is None:
            raise NotFoundError(f"user asset {asset_id} not found")
        return deleted

    @staticmethod
    def _extract_case_ids(value: Any) -> list[int]:
        items: list[int] = []
        if value is None:
            return items
        if isinstance(value, int):
            return [value] if value > 0 else []
        if isinstance(value, str):
            try:
                parsed = int(value)
            except ValueError:
                return []
            return [parsed] if parsed > 0 else []
        if isinstance(value, list):
            for item in value:
                if isinstance(item, int) and item > 0:
                    items.append(item)
                elif isinstance(item, str):
                    try:
                        parsed = int(item)
                    except ValueError:
                        continue
                    if parsed > 0:
                        items.append(parsed)
        return items

    @staticmethod
    def _extract_docx_text(file_base64: str) -> str:
        try:
            file_bytes = base64.b64decode(file_base64, validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError("Word 文档解析失败：文件内容不是合法 base64") from exc

        try:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as archive:
                document_xml = archive.read("word/document.xml")
        except zipfile.BadZipFile as exc:
            raise ValueError("Word 文档解析失败：文件不是合法 .docx") from exc
        except KeyError as exc:
            raise ValueError("Word 文档解析失败：缺少 word/document.xml") from exc

        try:
            root = ET.fromstring(document_xml)
        except ET.ParseError as exc:
            raise ValueError("Word 文档解析失败：XML 内容格式错误") from exc

        namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs: list[str] = []
        for paragraph in root.findall(".//w:p", namespace):
            segments: list[str] = []
            for node in paragraph.iter():
                if not isinstance(node.tag, str):
                    continue
                local_name = node.tag.rsplit("}", 1)[-1]
                if local_name == "t":
                    segments.append(node.text or "")
                elif local_name == "tab":
                    segments.append("\t")
                elif local_name in {"br", "cr"}:
                    segments.append("\n")
            text = "".join(segments).strip()
            if text:
                paragraphs.append(text)

        if not paragraphs:
            text_nodes = [node.text for node in root.findall(".//w:t", namespace) if node.text]
            fallback_text = "".join(text_nodes).strip()
            if fallback_text:
                return fallback_text
            raise ValueError("Word 文档内容为空，请检查文件内容")

        return "\n".join(paragraphs)

    @staticmethod
    def _detect_expected_output_schema(expected_output: dict) -> str:
        if "status_code" in expected_output:
            return "api"
        if "reference_answer" in expected_output:
            return "reference"
        raise ValueError("expected_output schema cannot be inferred")

    @staticmethod
    def _suite_matches_case_type(suite_type: str, case_type: str) -> bool:
        lowered = suite_type.lower()
        if case_type == "agent":
            return "agent" in lowered
        return "api" in lowered or lowered in {"regression", "smoke"}

    @staticmethod
    def _as_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    @staticmethod
    def _is_soft_deleted(record: dict[str, Any]) -> bool:
        status = str(record.get("status") or "").strip().lower()
        return status in {"deleted", "archived", "inactive"}

    @staticmethod
    def _normalize_report_channel_content(content: Any) -> dict[str, Any]:
        if not isinstance(content, dict):
            raise ValueError("report channel content_json is required")
        channel_type = str(content.get("channel_type") or "").strip() or "feishu_app"
        if channel_type not in SUPPORTED_REPORT_CHANNEL_TYPES:
            raise ValueError("report channel_type currently only supports feishu_app")

        app_id = str(content.get("app_id") or "").strip()
        app_secret = str(content.get("app_secret") or "").strip()
        chat_id = str(content.get("chat_id") or "").strip()
        if not app_id:
            raise ValueError("report app_id is required")
        if not app_secret:
            raise ValueError("report app_secret is required")
        if not chat_id:
            raise ValueError("report chat_id is required")

        default_message_raw = content.get("default_message")
        default_message = str(default_message_raw).strip() if isinstance(default_message_raw, str) else ""
        return {
            "channel_type": channel_type,
            "app_id": app_id[:128],
            "app_secret": app_secret[:512],
            "chat_id": chat_id[:128],
            "default_message": default_message[:500] if default_message else None,
        }
