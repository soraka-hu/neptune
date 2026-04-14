from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator, ValidationError


class CaseSchemaRegistry:
    _INPUT_SCHEMAS = {
        "api": "case_input_api.schema.json",
        "agent": "case_input_agent.schema.json",
    }

    _EXPECTED_SCHEMAS = {
        "api": "case_expected_api.schema.json",
        "reference": "case_expected_reference.schema.json",
    }

    _EVAL_CONFIG_SCHEMA = "case_eval_config.schema.json"

    @classmethod
    def validate_input_payload(cls, case_type: str, payload: dict[str, Any]) -> None:
        cls._validate("input_payload", case_type, payload, cls._INPUT_SCHEMAS)

    @classmethod
    def validate_expected_output(cls, expected_type: str, payload: dict[str, Any]) -> None:
        cls._validate("expected_output", expected_type, payload, cls._EXPECTED_SCHEMAS)

    @classmethod
    def validate_eval_config(cls, payload: dict[str, Any]) -> None:
        schema = cls._load_schema(cls._EVAL_CONFIG_SCHEMA)
        cls._validate_payload("eval_config", payload, schema)

    @classmethod
    def _validate(
        cls,
        payload_name: str,
        schema_key: str,
        payload: dict[str, Any],
        schema_map: dict[str, str],
    ) -> None:
        schema_file = schema_map.get(schema_key)
        if schema_file is None:
            raise ValueError(f"unsupported {payload_name} schema key: {schema_key}")
        schema = cls._load_schema(schema_file)
        cls._validate_payload(payload_name, payload, schema)

    @classmethod
    def _validate_payload(cls, payload_name: str, payload: dict[str, Any], schema: dict[str, Any]) -> None:
        try:
            Draft202012Validator(schema).validate(payload)
        except ValidationError as exc:
            path = ".".join(str(part) for part in exc.absolute_path)
            suffix = f" at {path}" if path else ""
            raise ValueError(f"invalid {payload_name}: {exc.message}{suffix}") from exc

    @staticmethod
    @lru_cache(maxsize=None)
    def _load_schema(schema_file: str) -> dict[str, Any]:
        schema_path = resources.files("app.domain.schemas").joinpath(schema_file)
        return json.loads(schema_path.read_text(encoding="utf-8"))

