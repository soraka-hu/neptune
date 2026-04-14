from pathlib import Path
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.main import app


def test_bind_rule_to_projects():
    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": "Rule Binding Project",
            "projectType": "hybrid",
            "description": "project for rule binding tests",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Rule Binding Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    rule_response = client.post(
        "/api/rules",
        json={
            "name": "Rule Binding Rule",
            "ruleType": "execution",
            "description": "rule for binding tests",
            "content": {"enabled": True},
        },
    )
    assert rule_response.status_code == 200
    rule_id = rule_response.json()["data"]["id"]

    response = client.post(
        f"/api/rules/{rule_id}/bind-projects",
        json={"projectIds": [project_id]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["ruleId"] == rule_id
    assert body["data"]["projectIds"] == [project_id]

    suite_bind = client.post(
        f"/api/rules/{rule_id}/bind-suites",
        json={"suiteIds": [suite_id]},
    )
    assert suite_bind.status_code == 200
    assert suite_bind.json()["data"]["suiteIds"] == [suite_id]


def test_rule_overview_contains_relation_counts():
    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": "Rule Overview Project",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Rule Overview Suite",
            "suiteType": "api",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    rule_response = client.post(
        "/api/rules",
        json={
            "name": "Rule Overview Rule",
            "ruleType": "assertion",
            "content": {"status": 200},
        },
    )
    assert rule_response.status_code == 200
    rule_id = rule_response.json()["data"]["id"]

    bind_project = client.post(
        f"/api/rules/{rule_id}/bind-projects",
        json={"projectIds": [project_id]},
    )
    assert bind_project.status_code == 200

    bind_suite = client.post(
        f"/api/rules/{rule_id}/bind-suites",
        json={"suiteIds": [suite_id]},
    )
    assert bind_suite.status_code == 200

    overview = client.get("/api/rules/overview", params={"ruleTypes": "assertion"})
    assert overview.status_code == 200
    items = overview.json()["data"]["items"]
    item = next(row for row in items if row["id"] == rule_id)
    assert item["project_count"] == 1
    assert item["suite_count"] == 1


def test_rule_relations_returns_project_and_suite_details():
    client = TestClient(app)
    project_response = client.post(
        "/api/projects",
        json={
            "name": "Rule Relation Project",
            "projectType": "hybrid",
        },
    )
    assert project_response.status_code == 200
    project_id = project_response.json()["data"]["id"]

    suite_response = client.post(
        "/api/suites",
        json={
            "projectId": project_id,
            "name": "Rule Relation Suite",
            "suiteType": "agent_eval",
        },
    )
    assert suite_response.status_code == 200
    suite_id = suite_response.json()["data"]["id"]

    rule_response = client.post(
        "/api/rules",
        json={
            "name": "Rule Relation Rule",
            "ruleType": "scoring",
            "content": {"threshold": 0.8},
        },
    )
    assert rule_response.status_code == 200
    rule_id = rule_response.json()["data"]["id"]

    bind_project = client.post(
        f"/api/rules/{rule_id}/bind-projects",
        json={"projectIds": [project_id]},
    )
    assert bind_project.status_code == 200

    bind_suite = client.post(
        f"/api/rules/{rule_id}/bind-suites",
        json={"suiteIds": [suite_id]},
    )
    assert bind_suite.status_code == 200

    relations = client.get(f"/api/rules/{rule_id}/relations")
    assert relations.status_code == 200
    payload = relations.json()["data"]
    assert payload["rule_id"] == rule_id
    assert payload["project_ids"] == [project_id]
    assert payload["suite_ids"] == [suite_id]
    assert payload["project_count"] == 1
    assert payload["suite_count"] == 1
    assert payload["projects"][0]["name"] == "Rule Relation Project"
    assert payload["suites"][0]["name"] == "Rule Relation Suite"


def test_rule_relations_returns_empty_when_no_binding():
    client = TestClient(app)
    rule_response = client.post(
        "/api/rules",
        json={
            "name": "Rule No Binding",
            "ruleType": "execution",
            "content": {"enabled": True},
        },
    )
    assert rule_response.status_code == 200
    rule_id = rule_response.json()["data"]["id"]

    relations = client.get(f"/api/rules/{rule_id}/relations")
    assert relations.status_code == 200
    payload = relations.json()["data"]
    assert payload["rule_id"] == rule_id
    assert payload["project_ids"] == []
    assert payload["suite_ids"] == []
    assert payload["project_count"] == 0
    assert payload["suite_count"] == 0


def test_bind_projects_can_replace_and_clear():
    client = TestClient(app)
    project_a = client.post(
        "/api/projects",
        json={"name": "Bind Replace Project A", "projectType": "hybrid"},
    )
    project_b = client.post(
        "/api/projects",
        json={"name": "Bind Replace Project B", "projectType": "hybrid"},
    )
    assert project_a.status_code == 200
    assert project_b.status_code == 200
    project_a_id = project_a.json()["data"]["id"]
    project_b_id = project_b.json()["data"]["id"]

    rule = client.post(
        "/api/rules",
        json={"name": "Bind Replace Rule", "ruleType": "execution", "content": {"enabled": True}},
    )
    assert rule.status_code == 200
    rule_id = rule.json()["data"]["id"]

    bind_a = client.post(f"/api/rules/{rule_id}/bind-projects", json={"projectIds": [project_a_id]})
    assert bind_a.status_code == 200
    assert bind_a.json()["data"]["projectIds"] == [project_a_id]

    bind_b = client.post(f"/api/rules/{rule_id}/bind-projects", json={"projectIds": [project_b_id]})
    assert bind_b.status_code == 200
    assert bind_b.json()["data"]["projectIds"] == [project_b_id]

    relations_after_replace = client.get(f"/api/rules/{rule_id}/relations")
    assert relations_after_replace.status_code == 200
    assert relations_after_replace.json()["data"]["project_ids"] == [project_b_id]

    bind_empty = client.post(f"/api/rules/{rule_id}/bind-projects", json={"projectIds": []})
    assert bind_empty.status_code == 200
    assert bind_empty.json()["data"]["projectIds"] == []

    relations_after_clear = client.get(f"/api/rules/{rule_id}/relations")
    assert relations_after_clear.status_code == 200
    assert relations_after_clear.json()["data"]["project_ids"] == []
