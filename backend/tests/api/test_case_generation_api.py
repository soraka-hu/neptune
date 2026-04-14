from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def test_generate_api_cases_respects_openapi_request_body(monkeypatch):
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Case Generation Project",
            "projectType": "hybrid",
            "description": "project for generation tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "titan_api",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    prd_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_agent_doc",
            "name": "prd_doc",
            "contentText": "聊天接口需覆盖正常与异常场景",
        },
    )
    assert prd_response.status_code == 200
    prd_doc_id = prd_response.json()["data"]["id"]

    openapi_doc = {
        "openapi": "3.0.0",
        "paths": {
            "/chat/{session_id}": {
                "post": {
                    "summary": "发送消息",
                    "parameters": [
                        {
                            "name": "session_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string", "example": "abc-123"},
                        },
                        {
                            "name": "X-Tenant-Id",
                            "in": "header",
                            "required": True,
                            "schema": {"type": "string", "example": "tenant-001"},
                        },
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["message", "thread_type"],
                                    "properties": {
                                        "message": {"type": "string", "example": "hello"},
                                        "thread_type": {"type": "string", "example": "chat"},
                                        "thread_id": {"type": "string", "nullable": True},
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "success",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer", "example": 0},
                                            "message": {"type": "string", "example": "success"},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            }
        },
    }
    api_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "api_doc",
            "name": "titan_chat",
            "contentJson": openapi_doc,
        },
    )
    assert api_doc_response.status_code == 200
    api_doc_id = api_doc_response.json()["data"]["id"]

    env_response = client.post(
        "/api/environments",
        json={
            "projectId": project_id,
            "name": "test_poc",
            "envType": "test",
            "baseUrl": "https://example.com",
            "headers": {
                "X-Tenant-Id": "tenant-from-env",
                "Cookie": "user_token=from_env;",
            },
            "status": "active",
        },
    )
    assert env_response.status_code == 200

    def fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, user_input, context, config
        return {
            "parsed_output": {
                "cases": [
                    {
                        "name": "对话接口正常返回",
                        "scenario_type": "normal",
                        "path_params": {"session_id": "generated-session"},
                        "query": {"unexpected": "should_be_removed"},
                        "headers": {"X-Tenant-Id": "tenant-from-llm"},
                        "body": {"message": "你好"},
                        "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},
                    }
                ]
            },
            "raw_output": "",
            "raw_response": {},
            "model_name": "qwen-max",
            "token_usage": {},
            "latency_ms": 10,
        }

    monkeypatch.setattr("app.application.api_case_generation_service.ModelGatewayClient.complete", fake_complete)

    generate_response = client.post(
        "/api/case-generation/generate",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "prdDocAssetId": prd_doc_id,
            "apiDocAssetId": api_doc_id,
            "count": 1,
            "coverage": "mixed",
            "model": "qwen-max",
        },
    )
    assert generate_response.status_code == 200
    data = generate_response.json()["data"]
    assert data["generated_count"] == 1
    assert len(data["case_ids"]) == 1

    case_detail = client.get(f"/api/cases/{data['case_ids'][0]}")
    assert case_detail.status_code == 200
    case_record = case_detail.json()["data"]
    case_payload = case_record["input_payload"]
    assert case_payload["method"] == "POST"
    assert case_payload["path"] == "/chat/generated-session"
    assert case_payload["query"] == {}
    assert case_payload["headers"]["X-Tenant-Id"] == "tenant-from-env"
    assert case_payload["headers"]["Cookie"] == "user_token=from_env;"
    assert case_payload["body"]["message"] == "你好"
    assert case_payload["body"]["thread_type"] == "chat"
    assert case_record["meta_info"]["scenario_type"] == "normal"

    history_response = client.get(f"/api/user-assets?projectId={project_id}&assetType=api_case_generation_batch")
    assert history_response.status_code == 200
    assert history_response.json()["data"]["total"] >= 1
    assert history_response.json()["data"]["items"][-1]["content_json"]["status"] == "success"


def test_generate_api_cases_applies_openapi_server_base_path(monkeypatch):
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Case Generation Server Path Project",
            "projectType": "hybrid",
            "description": "project for server path tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "titan_api",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    prd_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_agent_doc",
            "name": "prd_doc",
            "contentText": "聊天接口场景覆盖",
        },
    )
    assert prd_response.status_code == 200
    prd_doc_id = prd_response.json()["data"]["id"]

    openapi_doc = {
        "openapi": "3.0.0",
        "servers": [{"url": "https://nep-test.newqiye.com/api/titan/v1"}],
        "paths": {
            "/chat/{session_id}": {
                "post": {
                    "parameters": [
                        {
                            "name": "session_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string", "example": "abc-123"},
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["message", "thread_type"],
                                    "properties": {
                                        "message": {"type": "string", "example": "hello"},
                                        "thread_type": {"type": "string", "example": "chat"},
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "success",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer", "example": 0},
                                            "message": {"type": "string", "example": "success"},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            }
        },
    }
    api_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "api_doc",
            "name": "titan_chat",
            "contentJson": openapi_doc,
        },
    )
    assert api_doc_response.status_code == 200
    api_doc_id = api_doc_response.json()["data"]["id"]

    def fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, user_input, context, config
        return {
            "parsed_output": {
                "cases": [
                    {
                        "name": "对话接口正常返回",
                        "scenario_type": "normal",
                        "path_params": {"session_id": "generated-session"},
                        "query": {},
                        "headers": {},
                        "body": {"message": "你好", "thread_type": "chat"},
                        "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},
                    }
                ]
            },
            "raw_output": "",
            "raw_response": {},
            "model_name": "qwen-max",
            "token_usage": {},
            "latency_ms": 10,
        }

    monkeypatch.setattr("app.application.api_case_generation_service.ModelGatewayClient.complete", fake_complete)

    generate_response = client.post(
        "/api/case-generation/generate",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "prdDocAssetId": prd_doc_id,
            "apiDocAssetId": api_doc_id,
            "count": 1,
            "coverage": "mixed",
            "model": "qwen-max",
        },
    )
    assert generate_response.status_code == 200
    case_id = generate_response.json()["data"]["case_ids"][0]

    case_detail = client.get(f"/api/cases/{case_id}")
    assert case_detail.status_code == 200
    case_payload = case_detail.json()["data"]["input_payload"]
    assert case_payload["path"] == "/api/titan/v1/chat/generated-session"


def test_generate_api_cases_distributes_across_multiple_operations(monkeypatch):
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Case Generation Multi Operation Project",
            "projectType": "hybrid",
            "description": "project for multi operation generation tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "multi_operation_api_suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    prd_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_agent_doc",
            "name": "multi_operation_prd",
            "contentText": "同一套 API 里既有发送消息接口，也有历史查询接口。",
        },
    )
    assert prd_response.status_code == 200
    prd_doc_id = prd_response.json()["data"]["id"]

    openapi_doc = {
        "openapi": "3.0.0",
        "paths": {
            "/chat/{session_id}/send": {
                "post": {
                    "parameters": [
                        {
                            "name": "session_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string", "example": "send-001"},
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["message"],
                                    "properties": {
                                        "message": {"type": "string", "example": "你好"},
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "success",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer", "example": 0},
                                            "message": {"type": "string", "example": "success"},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            },
            "/chat/{session_id}/history": {
                "get": {
                    "parameters": [
                        {
                            "name": "session_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string", "example": "history-001"},
                        },
                        {
                            "name": "limit",
                            "in": "query",
                            "required": False,
                            "schema": {"type": "integer", "example": 20},
                        },
                    ],
                    "responses": {
                        "200": {
                            "description": "success",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer", "example": 0},
                                            "message": {"type": "string", "example": "success"},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            },
        },
    }
    api_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "api_doc",
            "name": "multi_operation_api_doc",
            "contentJson": openapi_doc,
        },
    )
    assert api_doc_response.status_code == 200
    api_doc_id = api_doc_response.json()["data"]["id"]

    seen_operations: list[str] = []

    def fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, context, config
        operation = user_input.get("operation") if isinstance(user_input, dict) else {}
        path_template = str(operation.get("path_template") or "")
        method = str(operation.get("method") or "")
        seen_operations.append(f"{method} {path_template}")

        if path_template == "/chat/{session_id}/send":
            return {
                "parsed_output": {
                    "cases": [
                        {
                            "name": "发送消息正常返回",
                            "scenario_type": "normal",
                            "path_params": {"session_id": "send-session"},
                            "query": {},
                            "headers": {},
                            "body": {"message": "你好"},
                            "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},
                        }
                    ]
                },
                "raw_output": "",
                "raw_response": {},
                "model_name": "qwen-max",
                "token_usage": {},
                "latency_ms": 10,
            }

        return {
            "parsed_output": {
                "cases": [
                    {
                        "name": "历史查询正常返回",
                        "scenario_type": "normal",
                        "path_params": {"session_id": "history-session"},
                        "query": {"limit": 10},
                        "headers": {},
                        "body": {},
                        "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},
                    }
                ]
            },
            "raw_output": "",
            "raw_response": {},
            "model_name": "qwen-max",
            "token_usage": {},
            "latency_ms": 10,
        }

    monkeypatch.setattr("app.application.api_case_generation_service.ModelGatewayClient.complete", fake_complete)

    generate_response = client.post(
        "/api/case-generation/generate",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "prdDocAssetId": prd_doc_id,
            "apiDocAssetId": api_doc_id,
            "count": 4,
            "coverage": "normal",
            "model": "qwen-max",
        },
    )
    assert generate_response.status_code == 200
    data = generate_response.json()["data"]
    assert data["generated_count"] == 4
    assert len(data["case_ids"]) == 4
    assert len(data["operations"]) == 2
    assert sum(int(item["requested_count"]) for item in data["operations"]) == 4

    operation_paths = {item["path"] for item in data["operations"]}
    assert operation_paths == {"/chat/{session_id}/send", "/chat/{session_id}/history"}
    assert set(seen_operations) == {"POST /chat/{session_id}/send", "GET /chat/{session_id}/history"}

    resolved_paths: set[str] = set()
    resolved_methods: set[str] = set()
    meta_operation_paths: set[str] = set()
    for case_id in data["case_ids"]:
        case_detail = client.get(f"/api/cases/{case_id}")
        assert case_detail.status_code == 200
        case_record = case_detail.json()["data"]
        case_payload = case_record["input_payload"]
        resolved_paths.add(case_payload["path"])
        resolved_methods.add(case_payload["method"])
        meta_operation_paths.add(case_record["meta_info"]["operation"]["path"])

    assert resolved_methods == {"POST", "GET"}
    assert "/chat/send-session/send" in resolved_paths
    assert "/chat/history-session/history" in resolved_paths
    assert meta_operation_paths == {"/chat/{session_id}/send", "/chat/{session_id}/history"}


def test_generate_api_cases_without_api_doc_is_supported(monkeypatch):
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Case Generation Without Api Doc Project",
            "projectType": "hybrid",
            "description": "project for generation tests without api doc",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "fallback_api_suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    prd_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_agent_doc",
            "name": "fallback_prd_doc",
            "contentText": "用户可以发送消息并收到结构化响应。",
        },
    )
    assert prd_response.status_code == 200
    prd_doc_id = prd_response.json()["data"]["id"]

    def fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, user_input, context, config
        return {
            "parsed_output": {
                "cases": [
                    {
                        "name": "默认接口正常返回",
                        "scenario_type": "normal",
                        "query": {},
                        "headers": {},
                        "body": {"message": "你好"},
                        "expected": {"status_code": 200, "json_fields": {"code": 0, "message": "success"}},
                    }
                ]
            },
            "raw_output": "",
            "raw_response": {},
            "model_name": "qwen-max",
            "token_usage": {},
            "latency_ms": 10,
        }

    monkeypatch.setattr("app.application.api_case_generation_service.ModelGatewayClient.complete", fake_complete)

    generate_response = client.post(
        "/api/case-generation/generate",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "prdDocAssetId": prd_doc_id,
            "count": 1,
            "coverage": "normal",
            "model": "qwen-max",
        },
    )
    assert generate_response.status_code == 200
    data = generate_response.json()["data"]
    assert data["generated_count"] == 1
    assert data["operation"]["method"] == "POST"
    assert data["operation"]["path"] == "/api/auto-generated"

    case_detail = client.get(f"/api/cases/{data['case_ids'][0]}")
    assert case_detail.status_code == 200
    case_record = case_detail.json()["data"]
    case_payload = case_record["input_payload"]
    assert case_payload["method"] == "POST"
    assert case_payload["path"] == "/api/auto-generated"
    assert case_payload["body"]["message"] == "你好"
    assert case_record["meta_info"].get("api_doc_id") is None

    history_response = client.get(f"/api/user-assets?projectId={project_id}&assetType=api_case_generation_batch")
    assert history_response.status_code == 200
    latest_batch = history_response.json()["data"]["items"][-1]["content_json"]
    assert latest_batch.get("api_doc_id") is None
    assert latest_batch["status"] == "success"


def test_generate_agent_dataset_maps_nullable_thread_id_to_null(monkeypatch):
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Agent Dataset Thread Id Project",
            "projectType": "hybrid",
            "description": "project for agent dataset generation tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "agent_benchmark_suite",
            "suiteType": "agent",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    source_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_agent_doc",
            "name": "agent_doc",
            "contentText": "你是一名情绪陪伴智能体，帮助用户倾诉和情绪梳理。",
        },
    )
    assert source_doc_response.status_code == 200
    source_doc_id = source_doc_response.json()["data"]["id"]

    openapi_doc = {
        "openapi": "3.0.0",
        "paths": {
            "/chat/send": {
                "post": {
                    "summary": "发送消息",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["message", "thread_type"],
                                    "properties": {
                                        "message": {"type": "string", "example": "你好"},
                                        "thread_type": {"type": "string", "example": "chat"},
                                        "thread_id": {
                                            "type": "string",
                                            "nullable": True,
                                            "example": "thread_id_sample",
                                        },
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "success",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "code": {"type": "integer", "example": 0},
                                            "message": {"type": "string", "example": "success"},
                                        },
                                    }
                                }
                            },
                        }
                    },
                }
            }
        },
    }
    api_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "api_doc",
            "name": "titan_chat",
            "contentJson": openapi_doc,
        },
    )
    assert api_doc_response.status_code == 200
    api_doc_id = api_doc_response.json()["data"]["id"]

    def fake_complete(self, *, project_id, prompt, user_input, context=None, config=None):
        del self, project_id, prompt, user_input, context, config
        return {
            "parsed_output": {
                "samples": [
                    {
                        "name": "陪伴样本",
                        "description": "用户情绪倾诉场景",
                        "scenario_type": "single_turn",
                        "user_input": "我最近特别焦虑，想和你聊聊。",
                        "conversation_history": [],
                        "tools_context": [],
                        "constraints": {"language": "zh", "format": "text"},
                    }
                ]
            },
            "raw_output": "",
            "raw_response": {},
            "model_name": "qwen-max",
            "token_usage": {},
            "latency_ms": 10,
        }

    monkeypatch.setattr("app.application.api_case_generation_service.ModelGatewayClient.complete", fake_complete)

    generate_response = client.post(
        "/api/case-generation/generate-agent-dataset",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "sourceDocAssetId": source_doc_id,
            "apiDocAssetId": api_doc_id,
            "count": 1,
            "withReference": False,
            "dimensions": ["single_turn"],
            "model": "qwen-max",
        },
    )
    assert generate_response.status_code == 200
    data = generate_response.json()["data"]
    assert data["generated_count"] == 1
    assert data["api_generated_count"] == 1
    assert len(data["api_case_ids"]) == 1

    api_case_id = data["api_case_ids"][0]
    case_detail = client.get(f"/api/cases/{api_case_id}")
    assert case_detail.status_code == 200
    case_payload = case_detail.json()["data"]["input_payload"]
    assert case_payload["method"] == "POST"
    assert case_payload["path"] == "/chat/send"
    assert case_payload["body"]["message"] == "我最近特别焦虑，想和你聊聊。"
    assert case_payload["body"]["thread_type"] == "chat"
    assert "thread_id" in case_payload["body"]
    assert case_payload["body"]["thread_id"] is None
