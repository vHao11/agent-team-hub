from fastapi.testclient import TestClient
import pytest

from teamhub.app import create_app
from conftest import active_item, assert_error, auth, command, create_item, get_item, operation, submit, success


def test_api_requires_valid_member_token(api):
    assert_error(api.get("/api/v1/work-items"), 401)
    assert_error(api.get("/api/v1/work-items", headers={"Authorization": "Bearer invalid"}), 401)


def test_bootstrap_does_not_expose_credentials(api):
    result = success(api.get("/api/v1/bootstrap", headers=auth("chen")))
    assert result["me"]["id"] == "u-chen"
    assert result["teams"]
    assert result["users"]
    assert "demo-lin" not in str(result)
    assert "demo-chen" not in str(result)
    assert all("token" not in user and "token_hash" not in user for user in result["users"])


def test_demo_credentials_exist_only_in_explicit_demo_mode(api, tmp_path):
    demo = success(api.get("/api/v1/demo"))
    assert {row["id"] for row in demo["identities"]} >= {"u-lin", "u-chen", "u-xu"}
    with TestClient(create_app(tmp_path / "private", demo=False)) as private:
        assert private.get("/api/v1/demo").status_code == 404
        assert private.get("/api/v1/bootstrap", headers=auth()).status_code == 401


@pytest.mark.parametrize("first_mode", [True, False])
def test_data_directory_mode_cannot_be_switched(tmp_path, first_mode):
    data_dir = tmp_path / "mode-bound"
    with TestClient(create_app(data_dir, demo=first_mode)):
        pass
    with pytest.raises(RuntimeError, match="模式"):
        with TestClient(create_app(data_dir, demo=not first_mode)):
            pass


def test_non_admin_cannot_create_other_members(api):
    response = api.post("/api/v1/users", headers=auth("chen"), json={
        "operation_id": operation(), "name": "非法创建", "team_id": "team-trading", "role": "admin"
    })
    assert_error(response, 403)


def test_create_retry_returns_same_id(api):
    op = operation()
    first = create_item(api, operation_id=op, title="幂等创建")
    second = create_item(api, operation_id=op, title="幂等创建")
    assert first["id"] == second["id"]
    found = success(api.get("/api/v1/work-items", params={"q": "幂等创建"}, headers=auth()))
    assert len([x for x in found["items"] if x["id"] == first["id"]]) == 1


def test_same_operation_id_cannot_change_payload(api):
    op = operation()
    create_item(api, operation_id=op, title="原始命令")
    body = {
        "operation_id": op, "title": "重用 ID 修改内容", "project_id": "proj-interface",
        "target_team_id": "team-clearing", "acceptance_spec": ["新条件"]
    }
    assert_error(api.post("/api/v1/work-items", headers=auth(), json=body), 409)


def test_accept_retry_uses_saved_receipt_even_with_old_expected_version(api):
    item = create_item(api)
    op = operation()
    first = success(command(api, item, "accept", operation_id=op, assignee_id="u-chen"))
    second = success(command(api, item, "accept", operation_id=op, assignee_id="u-chen"))
    assert first == second


def test_delivery_retry_does_not_duplicate_or_require_second_transition(api):
    item = active_item(api)
    op = operation()
    first = success(submit(api, item, operation_id=op))
    second = success(submit(api, item, operation_id=op))
    assert first["id"] == second["id"]
    detail = success(api.get(f"/api/v1/work-items/{item['id']}", headers=auth()))
    assert len(detail["deliveries"]) == 1
    assert detail["item"]["status"] == "review"


def test_stable_binding_is_not_duplicated(api):
    item = active_item(api)
    body = {"client_instance_id": "desktop-a", "harness": "dsh", "workspace_ref": "trade-core", "local_todo_id": "card-123"}
    first = success(api.post(f"/api/v1/work-items/{item['id']}/bindings", headers=auth("chen"), json={"operation_id": operation(), **body}))
    second = success(api.post(f"/api/v1/work-items/{item['id']}/bindings", headers=auth("chen"), json={"operation_id": operation(), **body}))
    assert first["id"] == second["id"]
    detail = success(api.get(f"/api/v1/work-items/{item['id']}", headers=auth("chen")))
    assert len(detail["bindings"]) == 1


def test_device_bindings_are_distinct(api):
    item = active_item(api)
    ids = []
    for instance in ("desktop-a", "laptop-b"):
        result = success(api.post(f"/api/v1/work-items/{item['id']}/bindings", headers=auth("chen"), json={
            "operation_id": operation(), "client_instance_id": instance, "harness": "dsh", "workspace_ref": "trade-core", "local_todo_id": "card-123"
        }))
        ids.append(result["id"])
    assert len(set(ids)) == 2


def test_event_feed_resumes_after_cursor_without_replaying_commands(api):
    before = success(api.get("/api/v1/events", params={"after": 0, "limit": 100}, headers=auth()))
    cursor = before["next_cursor"]
    item = create_item(api, title="事件增量验证")
    after = success(api.get("/api/v1/events", params={"after": cursor, "limit": 100}, headers=auth()))
    assert any(event["entity_id"] == item["id"] for event in after["events"])
    assert all(event["id"] > cursor for event in after["events"])
    assert after["next_cursor"] >= max(event["id"] for event in after["events"])
    repeated = success(api.get("/api/v1/events", params={"after": after["next_cursor"]}, headers=auth()))
    assert repeated["events"] == []
    assert get_item(api, item)["status"] == "open"


def test_uploaded_artifact_can_be_downloaded_and_submitted(api):
    content = "验证报告：所有约定场景已通过。".encode()
    artifact = success(api.post("/api/v1/artifacts", headers=auth("chen"), files={"file": ("report.txt", content, "text/plain")}))
    assert artifact["url"] == f"artifact://{artifact['id']}"
    download = api.get(f"/api/v1/artifacts/{artifact['id']}", headers=auth())
    assert download.status_code == 200
    assert download.content == content
    assert api.get(f"/api/v1/artifacts/{artifact['id']}").status_code == 401
    item = active_item(api)
    delivery = success(submit(api, item, artifacts=[{"label": "验证报告", "url": artifact["url"]}]))
    assert delivery["artifacts"][0]["url"] == artifact["url"]
