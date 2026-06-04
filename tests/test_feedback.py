"""Per-turn chat feedback (👍/👎) end-to-end:
- LocalJsonFeedbackRepository upsert + list + count semantics.
- POST /chat/feedback validation + tenant scoping.
- GET /admin/feedback role gating + summary.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import deps
from app.api import routes_admin_feedback, routes_chat
from app.db.feedback_repository import LocalJsonFeedbackRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture
def feedback_repo(tmp_path):
    return LocalJsonFeedbackRepository(tmp_path / "feedback_events.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, feedback_repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_chat, "get_feedback_repository", lambda: feedback_repo)
    monkeypatch.setattr(
        routes_admin_feedback, "get_feedback_repository", lambda: feedback_repo,
    )


# ---- repository ---------------------------------------------------------

def test_repo_upsert_keys_on_tenant_user_turn(feedback_repo):
    a = feedback_repo.upsert(
        tenant_id="t1", user_id="u1", turn_id="T-1", rating="up",
    )
    b = feedback_repo.upsert(
        tenant_id="t1", user_id="u1", turn_id="T-1", rating="down", reason="wrong",
    )
    # Same logical row updated, not duplicated.
    assert a.id == b.id
    rows = feedback_repo.list_records(tenant_id="t1")
    assert len(rows) == 1
    assert rows[0]["rating"] == "down"
    assert rows[0]["reason"] == "wrong"


def test_repo_rejects_bad_rating(feedback_repo):
    with pytest.raises(ValueError):
        feedback_repo.upsert(
            tenant_id="t1", user_id="u1", turn_id="T-1", rating="meh",
        )


def test_repo_rejects_overlong_reason(feedback_repo):
    with pytest.raises(ValueError):
        feedback_repo.upsert(
            tenant_id="t1", user_id="u1", turn_id="T-1", rating="down",
            reason="x" * 2001,
        )


def test_repo_tenant_scoped_listing(feedback_repo):
    feedback_repo.upsert(tenant_id="acme", user_id="u1", turn_id="T-1", rating="up")
    feedback_repo.upsert(tenant_id="ghost", user_id="u2", turn_id="T-2", rating="down")
    assert {r["tenant_id"] for r in feedback_repo.list_records(tenant_id="acme")} == {"acme"}
    assert feedback_repo.count(tenant_id="acme", rating="up") == 1
    assert feedback_repo.count(tenant_id="acme", rating="down") == 0


# ---- POST /chat/feedback ------------------------------------------------

def test_post_feedback_writes_record(feedback_repo):
    r = client.post(
        "/chat/feedback",
        headers=auth_headers(tenant_id="t1", user_id="u1"),
        json={"turn_id": "T-42", "rating": "up"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["turn_id"] == "T-42"
    assert body["rating"] == "up"
    # And it's actually persisted under the JWT's tenant.
    rows = feedback_repo.list_records(tenant_id="t1")
    assert len(rows) == 1 and rows[0]["user_id"] == "u1"


def test_post_feedback_rejects_unknown_rating():
    r = client.post(
        "/chat/feedback",
        headers=auth_headers(),
        json={"turn_id": "T-1", "rating": "meh"},
    )
    assert r.status_code == 422


def test_post_feedback_requires_auth():
    r = client.post("/chat/feedback", json={"turn_id": "T-1", "rating": "up"})
    assert r.status_code == 401


def test_feedback_is_tenant_scoped_on_write(feedback_repo):
    """A user from tenant 't1' can't write under tenant 'other' even if they
    try - the route reads tenant_id from the JWT, not the request body."""
    client.post(
        "/chat/feedback",
        headers=auth_headers(tenant_id="t1", user_id="u-tenant1"),
        json={"turn_id": "T-A", "rating": "up"},
    )
    client.post(
        "/chat/feedback",
        headers=auth_headers(tenant_id="other", user_id="u-other"),
        json={"turn_id": "T-B", "rating": "down"},
    )
    assert {r["tenant_id"] for r in feedback_repo.list_records(tenant_id="t1")} == {"t1"}
    assert {r["tenant_id"] for r in feedback_repo.list_records(tenant_id="other")} == {"other"}


# ---- GET /admin/feedback ------------------------------------------------

def test_admin_feedback_requires_admin_role(feedback_repo):
    # Seed one row first.
    client.post(
        "/chat/feedback",
        headers=auth_headers(tenant_id="t1", role="admin"),
        json={"turn_id": "T-99", "rating": "up"},
    )
    # Plain engineer can't read.
    r = client.get(
        "/admin/feedback", headers=auth_headers(tenant_id="t1", role="engineer"),
    )
    assert r.status_code == 403
    # Admin can.
    r = client.get(
        "/admin/feedback", headers=auth_headers(tenant_id="t1", role="admin"),
    )
    assert r.status_code == 200
    assert len(r.json()["feedback"]) == 1


def test_admin_feedback_summary_returns_counts(feedback_repo):
    for r in (("up", "T-1"), ("up", "T-2"), ("down", "T-3")):
        client.post(
            "/chat/feedback",
            headers=auth_headers(tenant_id="t1", role="admin", user_id=f"u-{r[1]}"),
            json={"turn_id": r[1], "rating": r[0]},
        )
    r = client.get(
        "/admin/feedback/summary",
        headers=auth_headers(tenant_id="t1", role="admin"),
    )
    body = r.json()
    assert body == {"tenant_id": "t1", "up": 2, "down": 1, "total": 3}


def test_admin_feedback_cross_tenant_blocked_for_tenant_admin(feedback_repo):
    """A tenant admin cannot read another tenant's feedback. Platform admin
    can - that path is exercised in the audit-cross-tenant suite already."""
    r = client.get(
        "/admin/feedback?tenant_id=someone-else",
        headers=auth_headers(tenant_id="my-tenant", role="admin"),
    )
    assert r.status_code == 403


# ---- slice 3: feedback POST also moves chunk weights -------------------

def test_feedback_post_updates_chunk_weights_via_attribution(
    feedback_repo, monkeypatch, tmp_path,
):
    """End-to-end: orchestrator remembers (tenant, turn) -> chunk_ids, the
    feedback POST looks them up server-side and bumps the per-tenant
    weights. The frontend never sends chunk_ids; that prevents a malicious
    client from targeting arbitrary chunks (e.g. a safety SOP)."""
    from app.core import turn_attribution
    from app.db.chunk_weights_repository import LocalJsonChunkWeightsRepository

    turn_attribution.reset_for_tests()
    weights_repo = LocalJsonChunkWeightsRepository(tmp_path / "weights.jsonl")
    monkeypatch.setattr(
        "app.db.chunk_weights_repository.get_chunk_weights_repository",
        lambda: weights_repo,
    )

    # Simulate the orchestrator finishing a turn that retrieved chunks 10 + 20.
    turn_attribution.remember_turn_chunks(
        tenant_id="t1", turn_id="T-XYZ", chunk_ids=[10, 20],
    )

    r = client.post(
        "/chat/feedback",
        headers=auth_headers(tenant_id="t1", user_id="u1"),
        json={"turn_id": "T-XYZ", "rating": "down"},
    )
    assert r.status_code == 200

    # Both chunks bumped per the policy (1.0 * 0.9 = 0.9).
    weights = weights_repo.get_weights(tenant_id="t1", chunk_ids=[10, 20])
    assert set(weights.keys()) == {10, 20}
    assert all(0.85 < w < 0.95 for w in weights.values())


def test_feedback_post_with_no_attribution_still_records_feedback(
    feedback_repo, tmp_path, monkeypatch,
):
    """If the attribution cache lost the (tenant, turn) -> chunks mapping
    (TTL expired, replica restarted, etc.), the feedback row still lands -
    only the weight update is skipped. The audit signal is the load-bearing
    part; the weight nudge is best-effort."""
    from app.core import turn_attribution
    from app.db.chunk_weights_repository import LocalJsonChunkWeightsRepository

    turn_attribution.reset_for_tests()
    weights_repo = LocalJsonChunkWeightsRepository(tmp_path / "weights.jsonl")
    monkeypatch.setattr(
        "app.db.chunk_weights_repository.get_chunk_weights_repository",
        lambda: weights_repo,
    )

    r = client.post(
        "/chat/feedback",
        headers=auth_headers(tenant_id="t1", user_id="u1"),
        json={"turn_id": "T-orphan", "rating": "up"},
    )
    assert r.status_code == 200
    rows = feedback_repo.list_records(tenant_id="t1")
    assert len(rows) == 1
    # No chunks to update, so the weights store stays empty.
    assert weights_repo.list_records(tenant_id="t1") == []
