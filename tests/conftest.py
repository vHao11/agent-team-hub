from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from teamhub.app import create_app


TOKENS = {"lin": "demo-lin", "chen": "demo-chen", "xu": "demo-xu"}


def auth(person: str = "lin") -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKENS[person]}"}


def operation() -> str:
    return str(uuid.uuid4())


@pytest.fixture
def api(tmp_path):
    app = create_app(tmp_path / "data", demo=True)
    with TestClient(app) as client:
        yield client


def success(response):
    assert response.status_code in (200, 201), (response.status_code, response.text)
    return response.json()


def create_item(api, *, title="API 验收事项", target="team-clearing", person="lin", **extra):
    body = {
        "operation_id": operation(),
        "title": title,
        "description": "由 API 行为测试创建的独立事项",
        "project_id": "proj-interface",
        "target_team_id": target,
        "acceptance_spec": ["提供可读取的交付材料", "验收条件逐项满足"],
    }
    body.update(extra)
    return success(api.post("/api/v1/work-items", json=body, headers=auth(person)))


def get_item(api, item, person="lin"):
    item_id = item if isinstance(item, str) else item["id"]
    return success(api.get(f"/api/v1/work-items/{item_id}", headers=auth(person)))["item"]


def command(api, item, action, *, person="chen", **extra):
    body = {"operation_id": operation(), "expected_version": item["version"], **extra}
    return api.post(f"/api/v1/work-items/{item['id']}/{action}", json=body, headers=auth(person))


def accepted_item(api, **kwargs):
    item = create_item(api, **kwargs)
    return success(command(api, item, "accept", assignee_id="u-chen"))


def active_item(api, **kwargs):
    return success(command(api, accepted_item(api, **kwargs), "start"))


def submit(api, item, *, person="chen", **extra):
    body = {
        "operation_id": operation(),
        "expected_version": item["version"],
        "spec_revision": item["spec_revision"],
        "summary": "已完成约定实现和验证，提交验收。",
        "artifacts": [{"label": "验证报告", "url": "https://example.com/report", "kind": "document"}],
        **extra,
    }
    return api.post(f"/api/v1/work-items/{item['id']}/deliveries", json=body, headers=auth(person))


def review(api, delivery, item, *, person="lin", decision="approve", **extra):
    body = {
        "operation_id": operation(),
        "expected_version": item["version"],
        "decision": decision,
        **extra,
    }
    return api.post(f"/api/v1/deliveries/{delivery['id']}/reviews", json=body, headers=auth(person))


def create_run(api, item, *, instance="desktop-a", person="chen", **extra):
    body = {
        "operation_id": operation(),
        "expected_version": item["version"],
        "client_instance_id": instance,
        "harness": "test-harness",
        "workspace_ref": "trading-core",
        **extra,
    }
    return api.post(f"/api/v1/work-items/{item['id']}/runs", json=body, headers=auth(person))


def run_event(api, run, status, sequence, *, person="chen", **extra):
    body = {
        "operation_id": operation(),
        "client_instance_id": run["client_instance_id"],
        "sequence": sequence,
        "status": status,
        "summary": f"执行适配器回报 {status}",
        **extra,
    }
    return api.post(f"/api/v1/runs/{run['id']}/events", json=body, headers=auth(person))


def assert_error(response, status=None, code=None):
    if status is not None:
        expected = status if isinstance(status, tuple) else (status,)
        assert response.status_code in expected, (response.status_code, response.text)
    else:
        assert response.status_code >= 400, (response.status_code, response.text)
    value = response.json()
    assert "error" in value, value
    assert value["error"].get("code"), value
    assert value["error"].get("message"), value
    if code is not None:
        assert value["error"]["code"] == code, value
    return value
