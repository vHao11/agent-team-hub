from conftest import (
    accepted_item,
    active_item,
    assert_error,
    auth,
    command,
    create_item,
    create_run,
    get_item,
    operation,
    run_event,
    submit,
    success,
)


def test_run_success_never_completes_business_item(api):
    item = accepted_item(api)
    run = success(create_run(api, item))
    assert run["status"] == "queued"
    assert run["dispatch_id"]
    success(run_event(api, run, "running", 1, external_session_id="session-1"))
    result = success(run_event(api, run, "succeeded", 2))
    assert result["status"] == "succeeded"
    assert get_item(api, item)["status"] == "active"
    detail = success(api.get(f"/api/v1/work-items/{item['id']}", headers=auth()))
    assert detail["deliveries"] == []
    assert detail["reviews"] == []


def test_same_start_request_is_not_restarted(api):
    item = accepted_item(api)
    op = operation()
    first = success(create_run(api, item, operation_id=op))
    second = success(create_run(api, item, operation_id=op))
    assert first["id"] == second["id"]
    assert first["dispatch_id"] == second["dispatch_id"]


def test_second_device_cannot_start_over_existing_execution(api):
    item = accepted_item(api)
    success(create_run(api, item, instance="desktop-a"))
    current = get_item(api, item)
    assert_error(create_run(api, current, instance="laptop-b"), 409)


def test_unknown_execution_holds_slot_until_result_confirmed(api):
    item = accepted_item(api)
    run = success(create_run(api, item))
    unknown = success(run_event(api, run, "unknown", 1))
    assert unknown["status"] == "unknown"
    assert_error(create_run(api, get_item(api, item), instance="laptop-b"), 409)
    assert success(run_event(api, run, "succeeded", 2))["status"] == "succeeded"
    assert get_item(api, item)["status"] == "active"


def test_out_of_order_runtime_report_cannot_rollback_status(api):
    item = accepted_item(api)
    run = success(create_run(api, item))
    success(run_event(api, run, "running", 2))
    delayed = success(run_event(api, run, "starting", 1))
    assert delayed["status"] == "running"
    assert delayed["sequence"] == 2


def test_terminal_runtime_cannot_return_to_running(api):
    run = success(create_run(api, accepted_item(api)))
    success(run_event(api, run, "succeeded", 1))
    response = run_event(api, run, "running", 2)
    if response.status_code in (200, 201):
        assert response.json()["status"] == "succeeded"
    else:
        assert_error(response, 409)
    current = success(api.get(f"/api/v1/runs/{run['id']}", headers=auth("chen")))
    assert current["status"] == "succeeded"


def test_only_run_owner_and_matching_instance_can_report(api):
    run = success(create_run(api, accepted_item(api)))
    assert_error(run_event(api, run, "running", 1, person="xu"), 403)
    assert_error(run_event(api, run, "running", 1, client_instance_id="different-device"), (400, 403, 409))


def test_cancel_is_request_until_executor_confirms(api):
    run = success(create_run(api, accepted_item(api)))
    success(run_event(api, run, "running", 1))
    cancel = success(api.post(f"/api/v1/runs/{run['id']}/cancel", headers=auth("chen"), json={"operation_id": operation()}))
    assert cancel["status"] == "cancel_requested"
    late_heartbeat = success(run_event(api, run, "running", 2))
    assert late_heartbeat["status"] == "cancel_requested"
    confirmed = success(run_event(api, run, "cancelled", 3))
    assert confirmed["status"] == "cancelled"


def test_runtime_completion_cannot_reopen_cancelled_item(api):
    item = accepted_item(api)
    run = success(create_run(api, item))
    current = get_item(api, item)
    cancelled = success(command(api, current, "cancel", person="lin", reason="本轮需求作废"))
    assert cancelled["status"] == "cancelled"
    result = success(run_event(api, run, "succeeded", 1))
    assert result["status"] == "succeeded"
    assert get_item(api, item)["status"] == "cancelled"


def test_runtime_heartbeat_does_not_change_item_version(api):
    item = accepted_item(api)
    run = success(create_run(api, item))
    before = get_item(api, item)
    success(run_event(api, run, "running", 1))
    success(run_event(api, run, "running", 2))
    after = get_item(api, item)
    assert after["version"] == before["version"]
    assert after["spec_revision"] == before["spec_revision"]


def test_transfer_cannot_abandon_an_unconfirmed_execution(api):
    item = accepted_item(api)
    run = success(create_run(api, item))
    item = get_item(api, item)
    pending = success(command(api, item, "transfer-requests", target_team_id="team-qa", reason="移交验证"))
    assert_error(command(api, pending, "accept-transfer", person="xu", assignee_id="u-xu"), 409)
    assert get_item(api, item)["owner_team_id"] == "team-clearing"
    success(run_event(api, run, "cancelled", 1))
    transferred = success(command(api, pending, "accept-transfer", person="xu", assignee_id="u-xu"))
    assert transferred["owner_team_id"] == "team-qa"


def test_new_run_checks_predecessor_acceptance(api):
    predecessor = create_item(api, title="尚未完成的前置事项")
    dependent = create_item(api, title="依赖前置的执行")
    dependent = success(command(api, dependent, "dependencies", person="lin", depends_on_id=predecessor["id"]))
    dependent = success(command(api, dependent, "accept", assignee_id="u-chen"))
    assert_error(create_run(api, dependent), 409)
    assert get_item(api, dependent)["status"] == "accepted"


def test_delivery_cannot_claim_another_items_run(api):
    first = active_item(api, title="第一条事项")
    second = active_item(api, title="第二条事项")
    run = success(create_run(api, first))
    success(run_event(api, run, "succeeded", 1))
    assert_error(submit(api, second, run_ids=[run["id"]]), (400, 422))
    assert get_item(api, second)["status"] == "active"
