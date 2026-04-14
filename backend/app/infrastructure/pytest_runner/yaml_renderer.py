from __future__ import annotations

from pathlib import Path
from typing import Any


class YamlRenderer:
    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or Path(__file__).resolve().parents[3] / ".runtime" / "runs"

    def render_run_item_config(
        self,
        run_record: dict[str, Any],
        run_item: dict[str, Any],
        case_item: dict[str, Any],
    ) -> Path:
        run_dir = self.base_dir / f"run-{run_record['id']}"
        run_dir.mkdir(parents=True, exist_ok=True)
        output_path = run_dir / f"run-item-{run_item['id']}.yaml"

        input_payload = case_item.get("input_payload") or {}
        expected_output = case_item.get("expected_output") or {}
        payload = {
            "run_id": run_record["id"],
            "run_no": run_record.get("run_no"),
            "run_type": run_record.get("run_type"),
            "request_snapshot": run_record.get("request_snapshot") or {},
            "versions": {
                "case_version": (run_item.get("request_data") or {}).get("case_version"),
                "schema_version": input_payload.get("schema_version"),
            },
            "case": {
                "id": case_item.get("id"),
                "name": case_item.get("name"),
                "case_type": case_item.get("case_type"),
                "input_payload": input_payload,
                "expected_output": expected_output,
            },
        }
        output_path.write_text(self._to_yaml(payload).rstrip() + "\n", encoding="utf-8")
        return output_path

    def _to_yaml(self, value: Any, indent: int = 0) -> str:
        prefix = "  " * indent
        if isinstance(value, dict):
            lines: list[str] = []
            for key, item in value.items():
                if isinstance(item, (dict, list)):
                    lines.append(f"{prefix}{key}:")
                    lines.append(self._to_yaml(item, indent + 1))
                else:
                    lines.append(f"{prefix}{key}: {self._scalar(item)}")
            return "\n".join(lines)
        if isinstance(value, list):
            lines = []
            for item in value:
                if isinstance(item, (dict, list)):
                    lines.append(f"{prefix}-")
                    lines.append(self._to_yaml(item, indent + 1))
                else:
                    lines.append(f"{prefix}- {self._scalar(item)}")
            return "\n".join(lines)
        return f"{prefix}{self._scalar(value)}"

    @staticmethod
    def _scalar(value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        text = str(value)
        if text == "1.0":
            return "'1.0'"
        if any(ch in text for ch in [":", "{", "}", "[", "]", "#"]) or text.strip() != text or text == "":
            return f"'{text}'"
        return text
