from datetime import date, datetime
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.infrastructure.llm.model_gateway_client import GatewayConfig, ModelGatewayClient


def test_judge_uses_longer_default_timeout(monkeypatch):
    client = ModelGatewayClient()
    captured: dict[str, int] = {}

    def fake_post(*, gateway, body):
        captured["timeout_seconds"] = gateway.timeout_seconds
        return {
            "model": "mock-model",
            "choices": [
                {
                    "message": {
                        "content": '{"score": 0.92, "reason": "ok", "dimensions": [{"name":"quality","score":0.92,"reason":"ok"}]}'
                    }
                }
            ],
        }

    monkeypatch.setattr(client, "_post_chat_completion", fake_post)

    result = client.judge(
        prompt="judge",
        output={"answer": "x"},
        expected={"answer": "x"},
        config={
            "base_url": "http://mock-gateway",
            "model": "mock-model",
        },
        case_or_item={"run_id": 1},
    )

    assert captured["timeout_seconds"] == 60
    assert result["score"] == 0.92


def test_post_chat_completion_retries_on_timeout(monkeypatch):
    client = ModelGatewayClient()
    call_count = {"value": 0}

    class _FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        @staticmethod
        def getcode():
            return 200

        @staticmethod
        def read():
            return b'{"choices":[{"message":{"content":"{}"}}]}'

    def fake_urlopen(req, timeout):
        call_count["value"] += 1
        if call_count["value"] == 1:
            raise TimeoutError("The read operation timed out")
        return _FakeResponse()

    monkeypatch.setattr("app.infrastructure.llm.model_gateway_client.url_request.urlopen", fake_urlopen)
    monkeypatch.setattr("app.infrastructure.llm.model_gateway_client.time.sleep", lambda _seconds: None)

    payload = client._post_chat_completion(
        gateway=GatewayConfig(
            base_url="http://mock-gateway",
            api_key=None,
            model="mock-model",
            timeout_seconds=1,
            max_retries=1,
            retry_backoff_seconds=0,
        ),
        body={"messages": []},
    )

    assert call_count["value"] == 2
    assert isinstance(payload, dict)


class _FakeUserAssetRepository:
    def __init__(self, items):
        self._items = list(items)

    def list(self, filters=None):
        effective_filters = dict(filters or {})
        rows = []
        for item in self._items:
            matched = True
            for key, value in effective_filters.items():
                if item.get(key) != value:
                    matched = False
                    break
            if matched:
                rows.append(item)
        return rows


def test_resolve_gateway_config_supports_shared_model_config_by_project_ids():
    client = ModelGatewayClient(
        user_asset_repository=_FakeUserAssetRepository(
            [
                {
                    "id": 9,
                    "project_id": 1,
                    "asset_type": "model_config",
                    "content_json": {"base_url": "https://project-1.example/v1", "model": "gpt-5.4-mini"},
                },
                {
                    "id": 10,
                    "project_id": 1,
                    "asset_type": "model_config",
                    "content_json": {"base_url": "https://shared.example/v1", "model": "kimi-k2.5"},
                    "meta_info": {"project_ids": [1, 2, 3]},
                },
            ]
        )
    )

    gateway = client._resolve_gateway_config(project_id=2, case_or_item=None, config={})

    assert gateway.base_url == "https://shared.example/v1"
    assert gateway.model == "kimi-k2.5"


def test_resolve_gateway_config_prefers_direct_project_config_over_shared():
    client = ModelGatewayClient(
        user_asset_repository=_FakeUserAssetRepository(
            [
                {
                    "id": 21,
                    "project_id": 1,
                    "asset_type": "model_config",
                    "content_json": {"base_url": "https://shared.example/v1", "model": "shared-model"},
                    "meta_info": {"project_ids": [1, 2]},
                },
                {
                    "id": 22,
                    "project_id": 2,
                    "asset_type": "model_config",
                    "content_json": {"base_url": "https://project-2.example/v1", "model": "project2-model"},
                },
            ]
        )
    )

    gateway = client._resolve_gateway_config(project_id=2, case_or_item=None, config={})

    assert gateway.base_url == "https://project-2.example/v1"
    assert gateway.model == "project2-model"


def test_complete_serializes_datetime_in_user_input_and_context(monkeypatch):
    client = ModelGatewayClient()
    captured_body: dict[str, object] = {}

    def fake_post(*, gateway, body):
        captured_body["request"] = body
        return {
            "model": "mock-model",
            "choices": [
                {
                    "message": {
                        "content": '{"summary":"ok"}'
                    }
                }
            ],
        }

    monkeypatch.setattr(client, "_post_chat_completion", fake_post)

    result = client.complete(
        project_id=None,
        prompt="prompt",
        user_input={"generated_at": datetime(2026, 4, 10, 7, 15, 43)},
        context={"today": date(2026, 4, 10)},
        config={
            "base_url": "http://mock-gateway",
            "model": "mock-model",
        },
    )

    assert result["model_name"] == "mock-model"
    request = captured_body.get("request")
    assert isinstance(request, dict)
    messages = request.get("messages")
    assert isinstance(messages, list) and len(messages) >= 2
    user_content = messages[1]["content"]
    assert isinstance(user_content, str)
    serialized = json.loads(user_content)
    assert serialized["user_input"]["generated_at"] == "2026-04-10T07:15:43"
    assert serialized["context"]["today"] == "2026-04-10"
