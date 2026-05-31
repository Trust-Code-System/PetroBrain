"""
A9 tests: asset hierarchy + relationships, asset_context resolution, and
retrieval expansion via the asset graph.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_assets
from app.core import asset_context as asset_context_module
from app.core.asset_context import (
    resolve_asset_context,
    resolve_retrieval_assets,
)
from app.core.llm_service import LLMResponse
from app.core.orchestrator import Orchestrator
from app.db.assets_repository import LocalJsonAssetsRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture
def assets_repo(tmp_path):
    return LocalJsonAssetsRepository(
        tmp_path / "assets.jsonl",
        tmp_path / "asset_relationships.jsonl",
    )


@pytest.fixture(autouse=True)
def wire(monkeypatch, assets_repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_assets, "_repository", lambda: assets_repo)
    monkeypatch.setattr(asset_context_module, "_repository", lambda: assets_repo)
    # Orchestrator goes through asset_context_module via a lazy import in
    # orchestrator._resolve_asset_context, so patching the module factory is
    # enough - no extra orchestrator wiring required.


def _admin_headers(**overrides):
    return auth_headers(
        tenant_id=overrides.pop("tenant_id", "tenant-a"),
        user_id=overrides.pop("user_id", "alice"),
        role=overrides.pop("role", "admin"),
        allowed_assets=overrides.pop("allowed_assets", ["*"]),
        **overrides,
    )


def _seed_hierarchy(repo, tenant="tenant-a", suffix=""):
    s = suffix or ("-" + tenant.split("-")[-1])
    field = repo.create(tenant_id=tenant, type="field", name="Niger-Delta",
                        asset_id=f"field{s}")
    block = repo.create(tenant_id=tenant, type="block", name="OML-99",
                        parent_id=field.id, asset_id=f"block{s}")
    train = repo.create(tenant_id=tenant, type="train", name="Train A",
                        parent_id=block.id, asset_id=f"train{s}")
    eq = repo.create(tenant_id=tenant, type="equipment", name="Compressor K-101",
                     parent_id=train.id, asset_id=f"eq{s}")
    sibling = repo.create(tenant_id=tenant, type="equipment", name="Compressor K-102",
                          parent_id=train.id, asset_id=f"eq2{s}")
    return field, block, train, eq, sibling


# ---- repository: insertion, traversal, cross-tenant -------------------------

def test_repository_insert_and_descendants(assets_repo):
    field, block, train, eq, sibling = _seed_hierarchy(assets_repo)

    desc = assets_repo.descendants(tenant_id="tenant-a", asset_id=field.id)
    assert {a.id for a in desc} == {block.id, train.id, eq.id, sibling.id}

    desc_train = assets_repo.descendants(tenant_id="tenant-a", asset_id=train.id)
    assert {a.id for a in desc_train} == {eq.id, sibling.id}


def test_repository_path_to_root(assets_repo):
    field, block, train, eq, _ = _seed_hierarchy(assets_repo)
    path = assets_repo.path_to_root(tenant_id="tenant-a", asset_id=eq.id)
    assert [a.id for a in path] == [field.id, block.id, train.id, eq.id]
    assert [a.type for a in path] == ["field", "block", "train", "equipment"]


def test_repository_rejects_unknown_parent_and_cycles(assets_repo):
    _seed_hierarchy(assets_repo)
    with pytest.raises(ValueError, match="parent"):
        assets_repo.create(tenant_id="tenant-a", type="equipment",
                           name="orphan", parent_id="missing")
    # Reparent a leaf to itself is forbidden.
    with pytest.raises(ValueError):
        assets_repo.update(tenant_id="tenant-a", asset_id="eq-a",
                           parent_id="eq-a")
    # Reparent an ancestor under one of its descendants creates a cycle.
    with pytest.raises(ValueError, match="cycle"):
        assets_repo.update(tenant_id="tenant-a", asset_id="field-a",
                           parent_id="eq-a")


def test_repository_isolates_tenants(assets_repo):
    _seed_hierarchy(assets_repo, tenant="tenant-a")
    _seed_hierarchy(assets_repo, tenant="tenant-b")

    # Tenant A sees its own eq-a; tenant B has eq-b and cannot see eq-a.
    a = assets_repo.path_to_root(tenant_id="tenant-a", asset_id="eq-a")
    b_for_a_id = assets_repo.path_to_root(tenant_id="tenant-b", asset_id="eq-a")
    b_own = assets_repo.path_to_root(tenant_id="tenant-b", asset_id="eq-b")
    assert {a[0].tenant_id, a[-1].tenant_id} == {"tenant-a"}
    assert b_for_a_id == []
    assert {b_own[0].tenant_id, b_own[-1].tenant_id} == {"tenant-b"}

    # Tenant B cannot reparent its own asset under tenant A's root.
    with pytest.raises(ValueError):
        assets_repo.update(tenant_id="tenant-b", asset_id="eq-b",
                           parent_id="field-a")


def test_repository_requires_tenant(assets_repo):
    with pytest.raises(ValueError):
        assets_repo.list_records(tenant_id="")
    with pytest.raises(ValueError):
        assets_repo.descendants(tenant_id="", asset_id="x")
    with pytest.raises(ValueError):
        assets_repo.path_to_root(tenant_id="", asset_id="x")


# ---- relationships ----------------------------------------------------------

def test_repository_relationships(assets_repo):
    field, block, train, eq, sibling = _seed_hierarchy(assets_repo)
    edge = assets_repo.create_relationship(
        tenant_id="tenant-a", src_id=eq.id, dst_id=sibling.id, relation="feeds",
    )
    assert edge.id == 1
    edges = assets_repo.list_relationships(tenant_id="tenant-a", asset_id=eq.id)
    assert len(edges) == 1
    with pytest.raises(ValueError, match="duplicate"):
        assets_repo.create_relationship(
            tenant_id="tenant-a", src_id=eq.id, dst_id=sibling.id, relation="feeds",
        )


# ---- service: resolve_asset_context and resolve_retrieval_assets -----------

def test_resolve_asset_context_returns_path_string(assets_repo):
    _seed_hierarchy(assets_repo)
    ctx = resolve_asset_context(tenant_id="tenant-a", asset_id="eq-a")
    assert ctx is not None
    assert ctx.path_string == (
        "field:Niger-Delta → block:OML-99 → train:Train A → equipment:Compressor K-101"
    )
    assert ctx.asset_id == "eq-a"


def test_resolve_asset_context_unknown_returns_none(assets_repo):
    assert resolve_asset_context(tenant_id="tenant-a", asset_id="missing") is None
    assert resolve_asset_context(tenant_id="", asset_id="eq-a") is None
    assert resolve_asset_context(tenant_id="tenant-a", asset_id=None) is None


def test_resolve_retrieval_assets_walks_ancestors(assets_repo):
    _seed_hierarchy(assets_repo)
    ids = resolve_retrieval_assets(tenant_id="tenant-a", asset_id="eq-a")
    assert ids == ["field-a", "block-a", "train-a", "eq-a"]


# ---- routes -----------------------------------------------------------------

def test_route_create_get_list_descendants_path(assets_repo):
    field = client.post(
        "/assets",
        headers=_admin_headers(),
        json={"type": "field", "name": "Niger-Delta", "asset_id": "field-a"},
    )
    assert field.status_code == 201, field.text
    client.post(
        "/assets",
        headers=_admin_headers(),
        json={"type": "block", "name": "OML-99", "parent_id": "field-a",
              "asset_id": "block-a"},
    )
    eq = client.post(
        "/assets",
        headers=_admin_headers(),
        json={"type": "equipment", "name": "K-101", "parent_id": "block-a",
              "asset_id": "eq-a"},
    ).json()

    detail = client.get(f"/assets/{eq['id']}", headers=_admin_headers()).json()
    assert detail["name"] == "K-101"

    listing = client.get("/assets", headers=_admin_headers(),
                         params={"roots_only": True}).json()
    assert {a["id"] for a in listing["assets"]} == {"field-a"}

    children = client.get("/assets", headers=_admin_headers(),
                          params={"parent_id": "block-a"}).json()
    assert {a["id"] for a in children["assets"]} == {"eq-a"}

    desc = client.get("/assets/field-a/descendants", headers=_admin_headers()).json()
    assert {a["id"] for a in desc["descendants"]} == {"block-a", "eq-a"}

    path = client.get("/assets/eq-a/path", headers=_admin_headers()).json()
    assert [n["id"] for n in path["path"]] == ["field-a", "block-a", "eq-a"]
    assert path["path_string"].startswith("field:Niger-Delta")


def test_route_create_requires_writer_role():
    r = client.post(
        "/assets",
        headers=auth_headers(role="field", allowed_assets=["*"]),
        json={"type": "field", "name": "Niger-Delta"},
    )
    assert r.status_code == 403


def test_route_patch_engineer_can_reparent(assets_repo):
    _seed_hierarchy(assets_repo)
    r = client.patch(
        "/assets/eq2-a",
        headers=auth_headers(tenant_id="tenant-a", user_id="ed", role="engineer",
                             allowed_assets=["*"]),
        json={"parent_id": "field-a"},
    )
    assert r.status_code == 200
    assert r.json()["parent_id"] == "field-a"


def test_route_patch_refuses_cycle(assets_repo):
    _seed_hierarchy(assets_repo)
    r = client.patch(
        "/assets/field-a",
        headers=_admin_headers(),
        json={"parent_id": "eq-a"},
    )
    assert r.status_code == 422
    assert "cycle" in r.json()["detail"]


def test_route_get_unknown_returns_404(assets_repo):
    r = client.get("/assets/missing", headers=_admin_headers())
    assert r.status_code == 404


def test_route_isolates_tenants(assets_repo):
    _seed_hierarchy(assets_repo, tenant="tenant-a")
    _seed_hierarchy(assets_repo, tenant="tenant-b")
    a = client.get("/assets/eq-a", headers=_admin_headers(tenant_id="tenant-a"))
    a_cross = client.get("/assets/eq-a", headers=_admin_headers(tenant_id="tenant-b"))
    b = client.get("/assets/eq-b", headers=_admin_headers(tenant_id="tenant-b"))
    assert a.status_code == 200 and a.json()["tenant_id"] == "tenant-a"
    assert a_cross.status_code == 404
    assert b.status_code == 200 and b.json()["tenant_id"] == "tenant-b"


def test_route_relationships(assets_repo):
    _seed_hierarchy(assets_repo)
    r = client.post(
        "/assets/eq-a/relationships",
        headers=_admin_headers(),
        json={"src_id": "eq-a", "dst_id": "eq2-a", "relation": "feeds"},
    )
    assert r.status_code == 201

    listing = client.get(
        "/assets/eq-a/relationships", headers=_admin_headers()
    ).json()
    assert len(listing["relationships"]) == 1
    assert listing["relationships"][0]["relation"] == "feeds"

    # Path-asset and edge endpoints must match.
    bad = client.post(
        "/assets/eq-a/relationships",
        headers=_admin_headers(),
        json={"src_id": "field-a", "dst_id": "block-a", "relation": "contains"},
    )
    assert bad.status_code == 422


# ---- orchestrator: asset_context expansion + retrieval list -----------------

class _SequenceLLM:
    def __init__(self, responses):
        self.responses = list(responses)

    async def complete(self, system_prompt, messages, tools=None):
        self.captured_system = system_prompt
        return self.responses.pop(0)


class _StaticRetriever:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def retrieve(self, query, *, tenant_id, asset=None, assets=None):
        self.calls.append({"tenant_id": tenant_id, "asset": asset, "assets": assets})
        return []


def test_orchestrator_resolves_known_asset_context(assets_repo):
    _seed_hierarchy(assets_repo)
    retriever = _StaticRetriever()
    llm = _SequenceLLM([LLMResponse(text="ok", tool_calls=[], usage={"input": 1, "output": 1},
                                    model="fake")])
    orch = Orchestrator(retriever=retriever, llm=llm)

    turn = asyncio.run(orch.handle(
        "What SOP applies to K-101 maintenance?",
        tenant_id="tenant-a", asset_context="eq-a",
    ))

    assert turn.answer == "ok"
    # The runtime_context block now carries the resolved path.
    assert "field:Niger-Delta → block:OML-99 → train:Train A → equipment:Compressor K-101" in llm.captured_system
    # The retriever received the ancestor list.
    assert retriever.calls[0]["assets"] == ["field-a", "block-a", "train-a", "eq-a"]
    assert retriever.calls[0]["asset"] is None


def test_orchestrator_falls_through_for_unknown_asset_context(assets_repo):
    _seed_hierarchy(assets_repo)
    retriever = _StaticRetriever()
    llm = _SequenceLLM([LLMResponse(text="ok", tool_calls=[], usage={}, model="fake")])
    orch = Orchestrator(retriever=retriever, llm=llm)

    asyncio.run(orch.handle(
        "Tell me about K-999",
        tenant_id="tenant-a", asset_context="unknown-free-text",
    ))

    # Unknown id falls through as free text - the prompt keeps the raw value
    # and the retriever uses the legacy single-asset filter.
    assert "asset_context: unknown-free-text" in llm.captured_system
    assert retriever.calls[0]["asset"] == "unknown-free-text"
    assert retriever.calls[0]["assets"] is None
