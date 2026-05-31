"""
Asset-context service (A9).

Two responsibilities:
- ``resolve_asset_context(tenant_id, asset_id)`` - build the human-readable
  Field → … → Asset path used in the system prompt's runtime_context, plus
  the structured records the orchestrator and routes can use.
- ``resolve_retrieval_assets(tenant_id, asset_id)`` - produce the list of
  asset ids the retriever should consider. Today we include the asset and
  every ancestor on the path to the root, so a query about Compressor K-101
  also surfaces SOPs filed against its train, block, and field.

Both lookups are tenant-scoped and ignore unknown ids silently (returning
None / empty list), so a free-text asset_context string from a legacy
client just falls through to the existing behaviour.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from app.db.assets_repository import AssetRecord, get_assets_repository


@dataclass
class AssetContext:
    asset_id: str
    name: str
    type: str
    path: list[AssetRecord]
    path_string: str

    def as_dict(self) -> dict:
        return {
            "asset_id": self.asset_id,
            "name": self.name,
            "type": self.type,
            "path": [asdict(r) for r in self.path],
            "path_string": self.path_string,
        }


def resolve_asset_context(*, tenant_id: str, asset_id: str | None) -> AssetContext | None:
    if not tenant_id or not asset_id:
        return None
    repo = _repository()
    path = repo.path_to_root(tenant_id=tenant_id, asset_id=asset_id)
    if not path:
        return None
    leaf = path[-1]
    return AssetContext(
        asset_id=leaf.id,
        name=leaf.name,
        type=leaf.type,
        path=path,
        path_string=" → ".join(f"{r.type}:{r.name}" for r in path),
    )


def resolve_retrieval_assets(*, tenant_id: str, asset_id: str | None) -> list[str]:
    """
    Return the asset ids the retriever should consider for a query bound
    to ``asset_id``. Today that is the asset itself plus every ancestor up
    to the root; an unknown id returns an empty list (caller falls back to
    untargeted retrieval).
    """
    if not tenant_id or not asset_id:
        return []
    path = _repository().path_to_root(tenant_id=tenant_id, asset_id=asset_id)
    return [r.id for r in path]


def _repository():
    return get_assets_repository()
