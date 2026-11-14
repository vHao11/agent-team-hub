from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from conftest import (
    accepted_item,
    active_item,
    assert_error,
    auth,
    command,
    create_item,
    get_item,
    operation,
    review,
    submit,
    success,
)


def test_request_accept_start_deliver_review(api):
    item = create_item(api)
    assert item["status"] == "open"
    assert item["owner_team_id"] == "team-trading"
    assert item["pending_target_team_id"] == "team-clearing"

    item = success(command(api, item, "accept", assignee_id="u-chen"))
    assert item["status"] == "accepted"
    assert item["owner_team_id"] == "team-clearing"
    assert item["pending_target_team_id"] is None
    assert item["assignee_id"] == "u-chen"

    item = success(command(api, item, "start"))
    assert item["status"] == "active"
    delivery = success(submit(api, item))
    item = get_item(api, item)
    assert item["status"] == "review"
    assert item["current_delivery_id"] == delivery["id"]
    item = success(review(api, delivery, item))
    assert item["status"] == "done"
    detail = success(api.get(f"/api/v1/work-items/{item['id']}", headers=auth()))
    assert len(detail["deliveries"]) == 1
    assert len(detail["reviews"]) == 1
    assert detail["reviews"][0]["decision"] == "approve"


def test_wrong_team_cannot_accept(api):
    item = create_item(api)
    assert_error(command(api, item, "accept", person="xu", assignee_id="u-xu"), 403)
    assert get_item(api, item)["owner_team_id"] == "team-trading"


def test_accept_cannot_assign_member_of_another_team(api):
    item = create_item(api)
    assert_error(command(api, item, "accept", assignee_id="u-xu"), (400, 403, 422))
    assert get_item(api, item)["status"] == "open"


def test_only_assignee_can_start(api):
    item = accepted_item(api)
    assert_error(command(api, item, "start", person="xu"), 403)
    assert get_item(api, item)["status"] == "accepted"


def test_only_named_reviewer_can_approve(api):
    item = active_item(api)
    delivery = success(submit(api, item))
    item = get_item(api, item)
    assert_error(review(api, delivery, item, person="chen"), 403)
    assert get_item(api, item)["status"] == "review"


def test_admin_cannot_replace_named_reviewer(api):
    item = active_item(api, reviewer_id="u-xu")
    delivery = success(submit(api, item))
    item = get_item(api, item)
    assert_error(review(api, delivery, item, person="lin"), 403)
    assert get_item(api, item)["status"] == "review"
    assert success(review(api, delivery, item, person="xu"))["status"] == "done"


def test_decline_returns_unaccepted_request_to_requester(api):
    item = create_item(api)
    item = success(command(api, item, "decline", reason="缺少接口说明，请补充后重新指派"))
    assert item["status"] == "open"
    assert item["pending_target_team_id"] is None
    assert item["owner_team_id"] == "team-trading"


def test_reviewer_can_request_changes_without_transferring_responsibility(api):
    item = active_item(api)
    first = success(submit(api, item))
    item = get_item(api, item)
    item = success(review(api, first, item, decision="request_changes", reason="补充边界场景验证"))
    assert item["status"] == "active"
    assert item["owner_team_id"] == "team-clearing"
    assert item["assignee_id"] == "u-chen"
    second = success(submit(api, item, summary="已经补充边界测试"))
    assert second["id"] != first["id"]
    assert second["sequence"] > first["sequence"]


def test_old_delivery_cannot_close_new_submission(api):
    item = active_item(api)
    first = success(submit(api, item))
    item = get_item(api, item)
    item = success(review(api, first, item, decision="request_changes", reason="请补测试"))
    second = success(submit(api, item))
    current = get_item(api, item)
    assert current["current_delivery_id"] == second["id"]
    assert_error(review(api, first, current), 409)
    assert get_item(api, item)["status"] == "review"
    assert success(review(api, second, current))["status"] == "done"


def test_new_submission_supersedes_current_review_without_erasing_history(api):
    item = active_item(api)
    first = success(submit(api, item, summary="第一版交付"))
    item = get_item(api, item)
    second = success(submit(api, item, summary="验收前补充的第二版交付"))
    current = get_item(api, item)
    assert current["status"] == "review"
    assert current["current_delivery_id"] == second["id"]
    assert second["sequence"] == first["sequence"] + 1
    assert_error(review(api, first, current), 409)
    detail = success(api.get(f"/api/v1/work-items/{item['id']}", headers=auth()))
    assert {delivery["id"] for delivery in detail["deliveries"]} == {first["id"], second["id"]}
    assert success(review(api, second, current))["status"] == "done"


def test_changed_acceptance_spec_invalidates_pending_review(api):
    item = active_item(api)
    delivery = success(submit(api, item))
    item = get_item(api, item)
    updated = success(command(
        api, item, "spec", person="lin", acceptance_spec=["覆盖新增业务场景"], reason="需求范围补充"
    ))
    assert updated["spec_revision"] == item["spec_revision"] + 1
    assert updated["status"] == "active"
    assert_error(review(api, delivery, updated), 409)
    assert_error(submit(api, updated, spec_revision=item["spec_revision"]), 409)


def test_progress_changes_version_but_not_requirement_revision(api):
    item = active_item(api)
    updated = success(command(api, item, "progress", summary="已完成结构体适配", blocked_reason="等待回报样例", waiting_on="交易研发组", next_action="补齐验证"))
    assert updated["spec_revision"] == item["spec_revision"]
    assert updated["status"] == "active"
    assert updated["blocked_reason"] == "等待回报样例"
    detail = success(api.get(f"/api/v1/work-items/{item['id']}", headers=auth()))
    assert any(x.get("summary") == "已完成结构体适配" for x in detail["progress"])


def test_transfer_keeps_old_owner_until_new_team_accepts(api):
    item = active_item(api)
    proposed = success(command(api, item, "transfer-requests", target_team_id="team-qa", reason="请质量保障组接续验证"))
    assert proposed["owner_team_id"] == "team-clearing"
    assert proposed["assignee_id"] == "u-chen"
    assert proposed["pending_target_team_id"] == "team-qa"
    assert_error(command(api, proposed, "accept-transfer", person="lin", assignee_id="u-lin"), 403)
    transferred = success(command(api, proposed, "accept-transfer", person="xu", assignee_id="u-xu"))
    assert transferred["owner_team_id"] == "team-qa"
    assert transferred["assignee_id"] == "u-xu"
    assert transferred["pending_target_team_id"] is None


def test_dependency_cycle_is_rejected(api):
    first = create_item(api, title="先行事项")
    second = create_item(api, title="后续事项")
    success(command(api, second, "dependencies", person="lin", depends_on_id=first["id"]))
    assert_error(command(api, first, "dependencies", person="lin", depends_on_id=second["id"]), (400, 409))


def test_start_waits_for_predecessor_acceptance(api):
    predecessor = active_item(api, title="前置交付")
    dependent = create_item(api, title="依赖事项")
    dependent = success(command(api, dependent, "dependencies", person="lin", depends_on_id=predecessor["id"]))
    dependent = success(command(api, dependent, "accept", assignee_id="u-chen"))
    assert_error(command(api, dependent, "start"), 409)
    delivery = success(submit(api, predecessor))
    predecessor = get_item(api, predecessor)
    assert_error(command(api, dependent, "start"), 409)
    success(review(api, delivery, predecessor))
    assert success(command(api, dependent, "start"))["status"] == "active"


@pytest.mark.parametrize("url", [r"D:\work\report.md", "file:///D:/work/report.md", "/tmp/report.md"])
def test_local_only_path_is_not_shared_delivery(api, url):
    item = active_item(api)
    assert_error(submit(api, item, artifacts=[{"label": "仅本机材料", "url": url}]), (400, 422))
    assert get_item(api, item)["status"] == "active"


def test_delivery_requires_an_artifact(api):
    item = active_item(api)
    assert_error(submit(api, item, artifacts=[]), (400, 422))


def test_stale_version_cannot_overwrite_new_progress(api):
    item = active_item(api)
    updated = success(command(api, item, "progress", summary="客户端 A 更新"))
    assert updated["version"] > item["version"]
    assert_error(command(api, item, "progress", summary="客户端 B 旧页面更新"), 409, "VERSION_CONFLICT")


def test_concurrent_accept_only_commits_once(api):
    item = create_item(api)
    second_member = success(api.post("/api/v1/users", headers=auth(), json={
        "operation_id": operation(), "name": "并发承接成员", "team_id": "team-clearing", "role": "member"
    }))
    barrier = Barrier(2)

    def attempt(token, assignee):
        barrier.wait(timeout=10)
        return api.post(f"/api/v1/work-items/{item['id']}/accept", headers={"Authorization": f"Bearer {token}"}, json={
            "operation_id": operation(), "expected_version": item["version"], "assignee_id": assignee
        })

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(attempt, "demo-chen", "u-chen"),
            pool.submit(attempt, second_member["token"], second_member["user"]["id"]),
        ]
        responses = [future.result(timeout=20) for future in futures]
    assert sorted(r.status_code for r in responses) in ([200, 409], [201, 409]), [(r.status_code, r.text) for r in responses]
    assert get_item(api, item)["owner_team_id"] == "team-clearing"
