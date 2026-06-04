"""Slice 3 of the learning loop: retrieval re-ranking from feedback.

Covers:
- LocalJsonChunkWeightsRepository.bump clamps to [floor, ceiling].
- update_weights_from_feedback walks the turn-attribution cache and bumps
  the right chunks.
- Retriever._apply_tenant_weights re-orders hits by tenant weight.
- Safety floor: no number of 👎 can demote a chunk past floor (so a safety
  SOP that the user finds annoying cannot be feedbacked into oblivion).
- Tenant isolation: weights are scoped per-tenant in writes AND reads.
"""
from __future__ import annotations

import pytest

from app.config import get_settings
from app.core import turn_attribution
from app.core.chunk_weight_updater import update_weights_from_feedback
from app.db.chunk_weights_repository import LocalJsonChunkWeightsRepository
from app.rag.retriever import _apply_tenant_weights


@pytest.fixture(autouse=True)
def reset_attribution():
    turn_attribution.reset_for_tests()
    yield
    turn_attribution.reset_for_tests()


@pytest.fixture
def weights_repo(tmp_path, monkeypatch):
    repo = LocalJsonChunkWeightsRepository(tmp_path / "weights.jsonl")
    monkeypatch.setattr(
        "app.db.chunk_weights_repository.get_chunk_weights_repository",
        lambda: repo,
    )
    return repo


# ---- repository ---------------------------------------------------------

def test_bump_creates_row_starting_from_1(weights_repo):
    settings = get_settings()
    record = weights_repo.bump(
        tenant_id="t1", chunk_id=42,
        multiplier=settings.chunk_weight_down_step, rating="down",
    )
    assert record.tenant_id == "t1" and record.chunk_id == 42
    # First 👎: 1.0 * 0.90 = 0.90, well above the floor.
    assert 0.85 < record.weight < 0.95
    assert record.down_count == 1 and record.up_count == 0


def test_bump_clamps_to_floor(weights_repo):
    """The safety guarantee: heavy negative feedback cannot drop a chunk
    below the floor. A safety SOP a tenant finds annoying still surfaces."""
    settings = get_settings()
    floor = settings.chunk_weight_floor
    # 50 thumbs-downs: 1.0 * 0.9^50 ~ 0.005 - would zero the chunk if not
    # clamped. The repo must clamp it to ``floor``.
    for _ in range(50):
        weights_repo.bump(
            tenant_id="t1", chunk_id=42,
            multiplier=settings.chunk_weight_down_step, rating="down",
        )
    row = weights_repo.get_weights(tenant_id="t1", chunk_ids=[42])
    assert row[42] == pytest.approx(floor, abs=1e-9)


def test_bump_clamps_to_ceiling(weights_repo):
    settings = get_settings()
    ceiling = settings.chunk_weight_ceiling
    for _ in range(50):
        weights_repo.bump(
            tenant_id="t1", chunk_id=42,
            multiplier=settings.chunk_weight_up_step, rating="up",
        )
    row = weights_repo.get_weights(tenant_id="t1", chunk_ids=[42])
    assert row[42] == pytest.approx(ceiling, abs=1e-9)


def test_get_weights_is_tenant_scoped(weights_repo):
    settings = get_settings()
    weights_repo.bump(
        tenant_id="acme", chunk_id=42,
        multiplier=settings.chunk_weight_down_step, rating="down",
    )
    # Same chunk_id, different tenant: must NOT see the bump.
    assert weights_repo.get_weights(tenant_id="acme", chunk_ids=[42]) != {}
    assert weights_repo.get_weights(tenant_id="ghost", chunk_ids=[42]) == {}


# ---- updater ------------------------------------------------------------

def test_update_walks_attribution_cache_and_bumps(weights_repo):
    turn_attribution.remember_turn_chunks(
        tenant_id="t1", turn_id="T-1", chunk_ids=[10, 20, 30],
    )
    updated = update_weights_from_feedback(
        tenant_id="t1", turn_id="T-1", rating="down",
    )
    assert updated == 3
    after = weights_repo.get_weights(tenant_id="t1", chunk_ids=[10, 20, 30])
    assert set(after.keys()) == {10, 20, 30}
    assert all(0.85 < w < 0.95 for w in after.values())


def test_update_with_no_attribution_is_safe(weights_repo):
    # No remember_turn_chunks() call - the attribution cache has nothing for
    # this (tenant, turn). Update must be a no-op, not a crash.
    assert update_weights_from_feedback(
        tenant_id="t1", turn_id="ghost", rating="up",
    ) == 0


def test_update_ignores_unknown_rating(weights_repo):
    turn_attribution.remember_turn_chunks(
        tenant_id="t1", turn_id="T-1", chunk_ids=[10],
    )
    assert update_weights_from_feedback(
        tenant_id="t1", turn_id="T-1", rating="meh",
    ) == 0
    # And no row created.
    assert weights_repo.get_weights(tenant_id="t1", chunk_ids=[10]) == {}


def test_attribution_is_tenant_scoped(weights_repo):
    """A 👎 in tenant 'acme' must not affect 'ghost' even with the same
    turn_id (UUIDs collide approximately never, but the isolation is
    enforced by the cache key including tenant_id)."""
    turn_attribution.remember_turn_chunks(
        tenant_id="acme", turn_id="T-shared", chunk_ids=[10],
    )
    update_weights_from_feedback(
        tenant_id="acme", turn_id="T-shared", rating="down",
    )
    # Different tenant, same turn_id: nothing to recall, so nothing bumped.
    assert update_weights_from_feedback(
        tenant_id="ghost", turn_id="T-shared", rating="down",
    ) == 0
    assert weights_repo.get_weights(tenant_id="ghost", chunk_ids=[10]) == {}


# ---- retriever application ----------------------------------------------

def test_apply_tenant_weights_reorders_by_weight(weights_repo):
    """A 👎-d chunk that initially ranked highest gets demoted below an
    untouched chunk after the weight is applied."""
    settings = get_settings()
    # Chunk 100 starts on top by RRF; chunk 200 is below it.
    hits = [
        {"id": 100, "rrf": 0.10, "text": "a", "title": "A", "revision": "1", "clause": "1"},
        {"id": 200, "rrf": 0.08, "text": "b", "title": "B", "revision": "1", "clause": "1"},
    ]
    # Several 👎s on 100 in tenant t1.
    for _ in range(5):
        weights_repo.bump(
            tenant_id="t1", chunk_id=100,
            multiplier=settings.chunk_weight_down_step, rating="down",
        )
    out = _apply_tenant_weights(hits, tenant_id="t1")
    # 100's adjusted score = 0.10 * 0.9^5 = 0.059; 200's = 0.08 * 1.0 = 0.08
    # -> 200 should rank above 100 now.
    assert out[0]["id"] == 200
    assert out[1]["id"] == 100


def test_apply_tenant_weights_no_change_on_empty_weights(weights_repo):
    hits = [
        {"id": 100, "rrf": 0.10},
        {"id": 200, "rrf": 0.08},
    ]
    out = _apply_tenant_weights(hits, tenant_id="t1")
    # Same order, untouched rrf.
    assert [h["id"] for h in out] == [100, 200]
    assert out[0]["rrf"] == 0.10


def test_apply_tenant_weights_tenant_scoped(weights_repo):
    """A weight set in tenant 'acme' must not affect retrieval in tenant
    'ghost' - chunks in ghost's search keep their original RRF order."""
    settings = get_settings()
    for _ in range(5):
        weights_repo.bump(
            tenant_id="acme", chunk_id=100,
            multiplier=settings.chunk_weight_down_step, rating="down",
        )
    hits = [
        {"id": 100, "rrf": 0.10},
        {"id": 200, "rrf": 0.08},
    ]
    out = _apply_tenant_weights(list(hits), tenant_id="ghost")
    assert [h["id"] for h in out] == [100, 200]
    # And in acme the order flips, confirming the lookup hits the right rows.
    out_acme = _apply_tenant_weights(list(hits), tenant_id="acme")
    assert out_acme[0]["id"] == 200


def test_safety_floor_keeps_chunk_in_retrieval(weights_repo):
    """The load-bearing safety guarantee: even after extreme negative
    feedback, the chunk is still in the hit list - the rerank still sees it
    and the model still gets a chance to cite it."""
    settings = get_settings()
    for _ in range(100):
        weights_repo.bump(
            tenant_id="t1", chunk_id=100,
            multiplier=settings.chunk_weight_down_step, rating="down",
        )
    hits = [
        {"id": 100, "rrf": 1.00, "text": "safety SOP"},
        {"id": 200, "rrf": 0.10, "text": "unrelated"},
    ]
    out = _apply_tenant_weights(hits, tenant_id="t1")
    # 100's score is 1.00 * 0.5 = 0.50 (clamped), still > 200's 0.10.
    # The point is: 100 is STILL in the list. No amount of 👎 can hide it.
    assert {h["id"] for h in out} == {100, 200}
    floored = next(h for h in out if h["id"] == 100)
    assert floored["tenant_weight"] == pytest.approx(0.5, abs=1e-9)
