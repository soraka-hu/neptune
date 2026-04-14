from __future__ import annotations

import json
import socket
import time
from datetime import date, datetime
from dataclasses import dataclass
from typing import Any
from urllib import error as url_error
from urllib import request as url_request

from app.infrastructure.repositories.table_repository import TableRepository


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass
class GatewayConfig:
    base_url: str
    api_key: str | None
    model: str
    timeout_seconds: int = 30
    max_retries: int = 1
    retry_backoff_seconds: float = 0.8


class ModelGatewayClient:
    def __init__(
        self,
        *,
        run_repository: TableRepository | None = None,
        user_asset_repository: TableRepository | None = None,
    ) -> None:
        self.run_repository = run_repository or TableRepository("run_record")
        self.user_asset_repository = user_asset_repository or TableRepository("user_asset")

    def complete(
        self,
        *,
        project_id: int | None,
        prompt: str,
        user_input: Any,
        context: dict[str, Any] | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        gateway = self._resolve_gateway_config(project_id=project_id, case_or_item=None, config=config or {})
        request_body = {
            "model": gateway.model,
            "temperature": _to_float((config or {}).get("temperature"), 0.0),
            "messages": [
                {"role": "system", "content": prompt or "You are a helpful assistant."},
                {
                    "role": "user",
                    "content": self._to_json_string(
                        {
                            "user_input": user_input,
                            "context": context or {},
                        }
                    ),
                },
            ],
        }
        started = time.perf_counter()
        response = self._post_chat_completion(gateway=gateway, body=request_body)
        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        message_content = self._extract_message_content(response)
        parsed_content = self._parse_json_like(message_content)
        parsed_output: Any = parsed_content if isinstance(parsed_content, (dict, list)) else message_content
        return {
            "parsed_output": parsed_output,
            "raw_output": message_content,
            "raw_response": response,
            "model_name": response.get("model", gateway.model),
            "model_version": (config or {}).get("model_version"),
            "token_usage": response.get("usage") if isinstance(response, dict) else None,
            "latency_ms": latency_ms,
        }

    @staticmethod
    def _normalize_score(value: Any) -> float:
        score = _to_float(value, 0.0)
        if score > 1.0:
            score = score / 100.0 if score <= 100 else 1.0
        return max(0.0, min(1.0, score))

    def judge(self, *, prompt: str, output: Any, expected: Any, config: dict[str, Any], case_or_item: dict[str, Any] | None = None) -> dict[str, Any]:
        judge_config = dict(config)
        if judge_config.get("timeout_seconds") is None:
            # Judge requests contain more context and are more likely to exceed 30s.
            judge_config["timeout_seconds"] = 60
        gateway = self._resolve_gateway_config(project_id=None, case_or_item=case_or_item, config=judge_config)
        judge_prompt = prompt or "Judge the output with score from 0 to 1."
        request_body = {
            "model": gateway.model,
            "temperature": _to_float(config.get("temperature"), 0.0),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an evaluation judge. "
                        "Return strict JSON with fields: score(number 0~1), reason(string), "
                        "dimensions(array of {name, score, reason})."
                    ),
                },
                {
                    "role": "user",
                    "content": self._to_json_string(
                        {
                            "judge_prompt": judge_prompt,
                            "expected": expected,
                            "output": output,
                            "rubric": config.get("rubric"),
                            "dimensions": config.get("dimensions"),
                        }
                    ),
                },
            ],
        }
        started = time.perf_counter()
        response = self._post_chat_completion(gateway=gateway, body=request_body)
        latency_ms = max(1, int((time.perf_counter() - started) * 1000))
        message_content = self._extract_message_content(response)
        parsed = self._parse_json_like(message_content)
        if not isinstance(parsed, dict):
            raise ValueError("model gateway judge response is not valid JSON object")

        score = self._normalize_score(parsed.get("score", parsed.get("total_score", 0.0)))
        reason = str(parsed.get("reason") or "judge result")
        raw_dimensions = parsed.get("dimensions")
        dimensions: list[dict[str, Any]] = []
        if isinstance(raw_dimensions, list):
            for item in raw_dimensions:
                if not isinstance(item, dict):
                    continue
                dimensions.append(
                    {
                        "name": str(item.get("name") or "llm_judge"),
                        "score": self._normalize_score(item.get("score", score)),
                        "reason": str(item.get("reason") or reason),
                    }
                )
        if not dimensions:
            dimensions = [{"name": "llm_judge", "score": score, "reason": reason}]

        return {
            "score": score,
            "reason": reason,
            "dimensions": dimensions,
            "model_name": response.get("model", gateway.model),
            "model_version": config.get("model_version"),
            "token_usage": response.get("usage") if isinstance(response, dict) else None,
            "latency_ms": latency_ms,
        }

    def _resolve_gateway_config(
        self,
        *,
        project_id: int | None,
        case_or_item: dict[str, Any] | None,
        config: dict[str, Any],
    ) -> GatewayConfig:
        override_base_url = config.get("base_url") or config.get("gateway_base_url")
        override_api_key = config.get("api_key") or config.get("gateway_api_key")
        override_model = config.get("model") or config.get("model_name")
        timeout_seconds = int(_to_float(config.get("timeout_seconds"), 30))
        max_retries = int(_to_float(config.get("max_retries"), 1))
        retry_backoff_seconds = _to_float(config.get("retry_backoff_seconds"), 0.8)

        resolved_project_id = project_id
        if resolved_project_id is None and case_or_item is not None:
            run_id = case_or_item.get("run_id")
            if isinstance(run_id, int):
                run_record = self.run_repository.get(run_id)
                if run_record is not None and isinstance(run_record.get("project_id"), int):
                    resolved_project_id = run_record["project_id"]

        if isinstance(override_base_url, str) and override_base_url.strip():
            return GatewayConfig(
                base_url=override_base_url.strip(),
                api_key=str(override_api_key).strip() if isinstance(override_api_key, str) and override_api_key.strip() else None,
                model=str(override_model).strip() if isinstance(override_model, str) and override_model.strip() else "gpt-5.4-mini",
                timeout_seconds=max(5, timeout_seconds),
                max_retries=max(0, max_retries),
                retry_backoff_seconds=max(0.0, retry_backoff_seconds),
            )

        if resolved_project_id is None:
            raise ValueError("model gateway config missing: project_id not resolved")

        model_asset = self._resolve_model_asset_for_project(resolved_project_id)
        if model_asset is None:
            raise ValueError(f"model gateway config missing for project {resolved_project_id}")
        content = model_asset.get("content_json")
        if not isinstance(content, dict):
            raise ValueError(f"model gateway config invalid for project {resolved_project_id}")
        base_url = content.get("base_url")
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError(f"model gateway base_url missing for project {resolved_project_id}")
        api_key = content.get("api_key")
        model = content.get("model")
        return GatewayConfig(
            base_url=base_url.strip(),
            api_key=api_key.strip() if isinstance(api_key, str) and api_key.strip() else None,
            model=model.strip() if isinstance(model, str) and model.strip() else "gpt-5.4-mini",
            timeout_seconds=max(5, timeout_seconds),
            max_retries=max(0, max_retries),
            retry_backoff_seconds=max(0.0, retry_backoff_seconds),
        )

    @staticmethod
    def _extract_bound_project_ids(asset: dict[str, Any]) -> set[int]:
        project_ids: set[int] = set()
        primary_project_id = asset.get("project_id")
        if isinstance(primary_project_id, int) and primary_project_id > 0:
            project_ids.add(primary_project_id)

        meta_info = asset.get("meta_info")
        if not isinstance(meta_info, dict):
            return project_ids

        raw_project_ids = meta_info.get("project_ids")
        if not isinstance(raw_project_ids, list):
            return project_ids

        for item in raw_project_ids:
            if isinstance(item, int) and item > 0:
                project_ids.add(item)
                continue
            if isinstance(item, str):
                try:
                    parsed = int(item)
                except ValueError:
                    continue
                if parsed > 0:
                    project_ids.add(parsed)
        return project_ids

    def _resolve_model_asset_for_project(self, project_id: int) -> dict[str, Any] | None:
        # First priority: explicit project-bound config.
        direct_assets = self.user_asset_repository.list({"project_id": project_id, "asset_type": "model_config"})
        if direct_assets:
            return direct_assets[-1]

        # Fallback: shared model config bound via meta_info.project_ids.
        all_model_assets = self.user_asset_repository.list({"asset_type": "model_config"})
        shared_assets = [asset for asset in all_model_assets if project_id in self._extract_bound_project_ids(asset)]
        if shared_assets:
            return shared_assets[-1]
        return None

    def _post_chat_completion(self, *, gateway: GatewayConfig, body: dict[str, Any]) -> dict[str, Any]:
        endpoint = gateway.base_url.strip()
        if endpoint.endswith("/"):
            endpoint = endpoint[:-1]
        if not endpoint.endswith("/chat/completions"):
            if endpoint.endswith("/v1"):
                endpoint = f"{endpoint}/chat/completions"
            elif endpoint.endswith("/v1/"):
                endpoint = f"{endpoint}chat/completions"
            else:
                endpoint = f"{endpoint}/v1/chat/completions"

        headers = {"Content-Type": "application/json"}
        if gateway.api_key:
            headers["Authorization"] = f"Bearer {gateway.api_key}"
        req = url_request.Request(
            endpoint,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        attempts = gateway.max_retries + 1
        last_timeout_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                with url_request.urlopen(req, timeout=gateway.timeout_seconds) as response:
                    status_code = response.getcode()
                    payload = response.read().decode("utf-8")
                break
            except url_error.HTTPError as exc:
                payload = exc.read().decode("utf-8", errors="replace")
                raise ValueError(f"model gateway http {exc.code}: {payload[:280]}") from exc
            except (TimeoutError, socket.timeout) as exc:
                last_timeout_error = exc
                if attempt >= attempts:
                    raise ValueError(f"model gateway read timeout after {gateway.timeout_seconds}s") from exc
                time.sleep(gateway.retry_backoff_seconds * attempt)
            except url_error.URLError as exc:
                reason_text = str(exc.reason).lower()
                is_timeout = isinstance(exc.reason, (TimeoutError, socket.timeout)) or "timed out" in reason_text
                if is_timeout:
                    last_timeout_error = exc
                    if attempt >= attempts:
                        raise ValueError(f"model gateway read timeout after {gateway.timeout_seconds}s") from exc
                    time.sleep(gateway.retry_backoff_seconds * attempt)
                    continue
                raise ValueError(f"model gateway unreachable: {exc.reason}") from exc
        else:
            if last_timeout_error is not None:
                raise ValueError(f"model gateway read timeout after {gateway.timeout_seconds}s") from last_timeout_error
            raise ValueError("model gateway request failed unexpectedly")

        if status_code >= 400:
            raise ValueError(f"model gateway http {status_code}: {payload[:280]}")
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ValueError("model gateway returned non-json response") from exc
        if not isinstance(parsed, dict):
            raise ValueError("model gateway returned invalid response")
        return parsed

    @staticmethod
    def _extract_message_content(response: dict[str, Any]) -> str:
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("model gateway response missing choices")
        first = choices[0]
        if not isinstance(first, dict):
            raise ValueError("model gateway response invalid choice payload")
        message = first.get("message")
        if not isinstance(message, dict):
            raise ValueError("model gateway response missing message")
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_chunks: list[str] = []
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    text_chunks.append(block["text"])
            if text_chunks:
                return "\n".join(text_chunks)
        raise ValueError("model gateway response missing textual content")

    @staticmethod
    def _parse_json_like(raw_text: str) -> Any:
        text = raw_text.strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                snippet = text[start : end + 1]
                try:
                    return json.loads(snippet)
                except json.JSONDecodeError:
                    return text
            return text

    @staticmethod
    def _to_json_string(payload: dict[str, Any]) -> str:
        return json.dumps(payload, ensure_ascii=False, default=ModelGatewayClient._json_default)

    @staticmethod
    def _json_default(value: Any) -> str:
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")
