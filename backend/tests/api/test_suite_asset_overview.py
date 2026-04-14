from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def test_suite_asset_overview_returns_backend_aggregates():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "Suite Overview Project",
            "projectType": "hybrid",
            "description": "project for suite overview",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "订单 API Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    prd_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_agent_doc",
            "name": "订单 PRD",
            "fileName": "order-prd.md",
            "contentText": "# 订单创建",
        },
    )
    assert prd_doc_response.status_code == 200
    prd_doc_id = prd_doc_response.json()["data"]["id"]

    api_doc_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "api_doc",
            "name": "订单 API 文档",
            "fileName": "order-api.json",
            "contentJson": {"path": "/api/order/create", "method": "POST"},
        },
    )
    assert api_doc_response.status_code == 200
    api_doc_id = api_doc_response.json()["data"]["id"]

    case_response = client.post(
        "/api/cases",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "name": "合法参数创建订单成功返回200",
            "caseType": "api",
            "sourceType": "llm_generated",
            "status": "active",
            "inputPayload": {
                "schema_version": "1.0",
                "method": "POST",
                "path": "/api/order/create",
                "headers": {"Content-Type": "application/json"},
                "query": {},
                "body": {"userId": 1001, "skuId": 2002, "count": 1},
            },
            "expectedOutput": {
                "schema_version": "1.0",
                "status_code": 200,
                "json_fields": {"code": 0},
            },
        },
    )
    assert case_response.status_code == 200

    batch_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "api_case_generation_batch",
            "name": "API 批次",
            "contentJson": {
                "batch_id": "api_batch_001",
                "suite_id": suite_id,
                "prd_doc_id": prd_doc_id,
                "api_doc_id": api_doc_id,
                "generated_count": 1,
                "status": "success",
            },
        },
    )
    assert batch_response.status_code == 200

    overview_response = client.get(
        f"/api/suite-asset-overview?projectId={project_id}&caseType=api"
    )
    assert overview_response.status_code == 200
    body = overview_response.json()
    assert body["code"] == 0
    assert body["data"]["total"] >= 1

    target = next(item for item in body["data"]["items"] if item["id"] == suite_id)
    assert target["case_count"] == 1
    assert target["source_summary"] == "llm_generated"
    assert target["linked_prd_doc_name"] == "订单 PRD"
    assert target["linked_api_doc_name"] == "订单 API 文档"
    assert target["last_generation_batch_id"] == "api_batch_001"
