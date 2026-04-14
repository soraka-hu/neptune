from pathlib import Path
import sys
import base64
import io
import zipfile
from xml.sax.saxutils import escape

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def _build_docx_base64(paragraphs: list[str]) -> str:
    body = "".join(
        f"<w:p><w:r><w:t>{escape(paragraph)}</w:t></w:r></w:p>"
        for paragraph in paragraphs
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body>"
        "</w:document>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", document_xml)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def test_user_asset_crud():
    client = TestClient(app)

    project_response = client.post(
        "/api/projects",
        json={
            "name": "User Asset Project",
            "projectType": "hybrid",
            "description": "project for user assets",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Asset Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    create_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "suiteId": suite_id,
            "assetType": "prd_md",
            "name": "需求文档A",
            "fileName": "prd.md",
            "contentText": "# 需求\n- 要点",
            "metaInfo": {"source": "upload"},
        },
    )
    assert create_response.status_code == 200
    asset_id = create_response.json()["data"]["id"]

    list_response = client.get(f"/api/user-assets?projectId={project_id}&assetType=prd_md")
    assert list_response.status_code == 200
    assert list_response.json()["data"]["total"] >= 1

    list_by_suite_response = client.get(f"/api/user-assets?projectId={project_id}&suiteId={suite_id}&assetType=prd_md")
    assert list_by_suite_response.status_code == 200
    assert list_by_suite_response.json()["data"]["total"] >= 1

    detail_response = client.get(f"/api/user-assets/{asset_id}")
    assert detail_response.status_code == 200
    assert detail_response.json()["data"]["name"] == "需求文档A"
    assert detail_response.json()["data"]["suite_id"] == suite_id

    update_response = client.put(
        f"/api/user-assets/{asset_id}",
        json={
            "name": "需求文档A-v2",
            "contentText": "# 需求更新\n- 新要点",
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["data"]["name"] == "需求文档A-v2"

    delete_response = client.delete(f"/api/user-assets/{asset_id}")
    assert delete_response.status_code == 200


def test_upload_prd_docx_extracts_text():
    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": "Word PRD Project",
            "projectType": "hybrid",
            "description": "project for docx upload",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    create_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "prd_agent_doc",
            "name": "智能体需求文档",
            "fileName": "agent-prd.docx",
            "fileBase64": _build_docx_base64(["第一段：智能体定位", "第二段：能力边界"]),
        },
    )
    assert create_response.status_code == 200
    content_text = create_response.json()["data"]["content_text"]
    assert "第一段：智能体定位" in content_text
    assert "第二段：能力边界" in content_text


def test_upload_prd_docx_invalid_payload_returns_400():
    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": "Word PRD Invalid Project",
            "projectType": "hybrid",
            "description": "project for invalid docx upload",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    create_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "prd_agent_doc",
            "name": "损坏文档",
            "fileName": "broken.docx",
            "fileBase64": "not-valid-base64",
        },
    )
    assert create_response.status_code == 400
    assert "Word 文档解析失败" in create_response.json()["message"]


def test_create_report_channel_requires_valid_feishu_app_credentials():
    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": "Report Channel Project",
            "projectType": "hybrid",
            "description": "project for report channel tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    invalid_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "report_channel",
            "name": "Invalid Channel",
            "contentJson": {
                "channel_type": "feishu_app",
                "app_secret": "missing-app-id",
                "chat_id": "oc_invalid",
            },
        },
    )
    assert invalid_response.status_code == 400
    assert "report app_id is required" in invalid_response.json()["message"]

    valid_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "report_channel",
            "name": "Valid Channel",
            "contentJson": {
                "channel_type": "feishu_app",
                "app_id": "cli_valid_channel",
                "app_secret": "secret_valid_channel",
                "chat_id": "oc_valid_channel",
                "default_message": "hello team",
            },
        },
    )
    assert valid_response.status_code == 200

    flow_response = client.post(
        "/api/user-assets",
        json={
            "projectId": project_id,
            "assetType": "report_channel",
            "name": "Valid Channel 2",
            "contentJson": {
                "channel_type": "feishu_app",
                "app_id": "cli_valid_channel_2",
                "app_secret": "secret_valid_channel_2",
                "chat_id": "oc_valid_channel_2",
            },
        },
    )
    assert flow_response.status_code == 200
