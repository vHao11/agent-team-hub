from conftest import accepted_item, assert_error, auth, create_run, operation, success


def publish_capability(api):
    capability = success(api.post("/api/v1/capabilities", headers=auth(), json={
        "operation_id": operation(), "slug": f"quality-{operation()}", "name": "接口检查能力",
        "description": "用于行为测试的共享能力", "kind": "skill", "tags": ["接口", "验证"]
    }))
    return capability


def release(api, capability, version, *, person="lin", **extra):
    return api.post(f"/api/v1/capabilities/{capability['id']}/releases", headers=auth(person), json={
        "operation_id": operation(), "version": version,
        "manifest": {"schema_version": 1, "kind": "skill", "entry": "SKILL.md", "version": version},
        "files": {"SKILL.md": "---\nname: interface-review\ndescription: Review interface changes\n---\nReview the supplied interface document.\n"},
        **extra,
    })


def test_release_version_is_immutable(api):
    capability = publish_capability(api)
    first = success(release(api, capability, "1.0.0"))
    assert_error(release(api, capability, "1.0.0", files={"SKILL.md": "overwrite"}), 409)
    fetched = success(api.get(f"/api/v1/capabilities/{capability['id']}/releases/1.0.0", headers=auth()))
    assert fetched["id"] == first["id"]
    assert fetched["files"] == first["files"]


def test_release_cannot_be_published_by_unrelated_team(api):
    capability = publish_capability(api)
    assert_error(release(api, capability, "1.0.0", person="xu"), 403)


def test_run_pins_toolset_versions_before_recommendation_changes(api):
    capability = publish_capability(api)
    first = success(release(api, capability, "1.0.0"))
    success(release(api, capability, "2.0.0"))
    toolset = success(api.get("/api/v1/team-toolsets/team-clearing", headers=auth()))
    toolset = success(api.put("/api/v1/team-toolsets/team-clearing", headers=auth(), json={
        "operation_id": operation(), "expected_version": toolset["version"],
        "items": [{"capability_id": capability["id"], "version": "1.0.0"}]
    }))
    run = success(create_run(api, accepted_item(api)))
    assert any(row["release_id"] == first["id"] and row["version"] == "1.0.0" for row in run["capability_releases"])
    success(api.put("/api/v1/team-toolsets/team-clearing", headers=auth(), json={
        "operation_id": operation(), "expected_version": toolset["version"],
        "items": [{"capability_id": capability["id"], "version": "2.0.0"}]
    }))
    refreshed = success(api.get(f"/api/v1/runs/{run['id']}", headers=auth("chen")))
    assert refreshed["capability_releases"] == run["capability_releases"]


def test_toolset_rejects_nonexistent_release(api):
    capability = publish_capability(api)
    toolset = success(api.get("/api/v1/team-toolsets/team-clearing", headers=auth()))
    result = api.put("/api/v1/team-toolsets/team-clearing", headers=auth(), json={
        "operation_id": operation(), "expected_version": toolset["version"],
        "items": [{"capability_id": capability["id"], "version": "99.0.0"}]
    })
    assert_error(result, (400, 404, 422))


def test_team_member_cannot_publish_team_wide_defaults(api):
    toolset = success(api.get("/api/v1/team-toolsets/team-clearing", headers=auth("chen")))
    result = api.put("/api/v1/team-toolsets/team-clearing", headers=auth("chen"), json={
        "operation_id": operation(), "expected_version": toolset["version"], "items": []
    })
    assert_error(result, 403)
