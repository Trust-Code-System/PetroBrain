"""
Asset hierarchy + relationships API (A9).

GET    /assets?root_id=&parent_id=&type=    list (roots or children)
POST   /assets                              create - admin or engineer
PATCH  /assets/{id}                         update - admin or engineer
GET    /assets/{id}                         single asset
GET    /assets/{id}/path                    path Field→...→Asset for the asset_context
GET    /assets/{id}/descendants             flat list of all descendants
GET    /assets/{id}/relationships           edges where src/dst == id
POST   /assets/{id}/relationships           create an edge - admin or engineer

All routes are tenant-scoped and refuse cross-tenant ids; the Postgres
backend adds RLS as defence in depth.
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import Principal, get_principal, require_role
from app.core.asset_context import resolve_asset_context
from app.db.assets_repository import get_assets_repository
from app.models.schemas import AssetCreate, AssetRelationshipCreate, AssetUpdate


router = APIRouter(prefix="/assets", tags=["assets"])
_writer = require_role("admin", "engineer")


@router.get("")
async def list_assets(
    parent_id: str | None = Query(default=None),
    root_id: str | None = Query(default=None),
    type: str | None = Query(default=None),
    roots_only: bool = Query(default=False),
    who: Principal = Depends(get_principal),
):
    if parent_id and root_id:
        raise HTTPException(status_code=422, detail="pass parent_id OR root_id, not both")
    repo = _repository()
    effective_parent = parent_id or root_id
    rows = repo.list_records(
        tenant_id=who.tenant_id,
        parent_id=effective_parent,
        roots_only=roots_only and not effective_parent,
        type=type,
    )
    return {"assets": [asdict(r) for r in rows]}


@router.post("", status_code=201)
async def create_asset(req: AssetCreate, who: Principal = Depends(_writer)):
    try:
        record = _repository().create(
            tenant_id=who.tenant_id,
            type=req.type,
            name=req.name,
            parent_id=req.parent_id,
            attributes=req.attributes,
            asset_id=req.asset_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return asdict(record)


@router.get("/{asset_id}")
async def get_asset(asset_id: str, who: Principal = Depends(get_principal)):
    record = _repository().get(tenant_id=who.tenant_id, asset_id=asset_id)
    if record is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return asdict(record)


@router.patch("/{asset_id}")
async def update_asset(asset_id: str, req: AssetUpdate, who: Principal = Depends(_writer)):
    try:
        record = _repository().update(
            tenant_id=who.tenant_id,
            asset_id=asset_id,
            type=req.type,
            name=req.name,
            parent_id=req.parent_id,
            clear_parent=req.clear_parent,
            attributes=req.attributes,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return asdict(record)


@router.get("/{asset_id}/path")
async def asset_path(asset_id: str, who: Principal = Depends(get_principal)):
    ctx = resolve_asset_context(tenant_id=who.tenant_id, asset_id=asset_id)
    if ctx is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return ctx.as_dict()


@router.get("/{asset_id}/descendants")
async def asset_descendants(asset_id: str, who: Principal = Depends(get_principal)):
    repo = _repository()
    if repo.get(tenant_id=who.tenant_id, asset_id=asset_id) is None:
        raise HTTPException(status_code=404, detail="asset not found")
    rows = repo.descendants(tenant_id=who.tenant_id, asset_id=asset_id)
    return {"asset_id": asset_id, "descendants": [asdict(r) for r in rows]}


@router.get("/{asset_id}/relationships")
async def asset_relationships(
    asset_id: str,
    relation: str | None = Query(default=None),
    who: Principal = Depends(get_principal),
):
    repo = _repository()
    if repo.get(tenant_id=who.tenant_id, asset_id=asset_id) is None:
        raise HTTPException(status_code=404, detail="asset not found")
    rows = repo.list_relationships(tenant_id=who.tenant_id, asset_id=asset_id, relation=relation)
    return {"asset_id": asset_id, "relationships": [asdict(r) for r in rows]}


@router.post("/{asset_id}/relationships", status_code=201)
async def create_relationship(
    asset_id: str, req: AssetRelationshipCreate, who: Principal = Depends(_writer),
):
    if req.src_id != asset_id and req.dst_id != asset_id:
        raise HTTPException(
            status_code=422,
            detail="path asset_id must appear as src_id or dst_id of the relationship",
        )
    try:
        edge = _repository().create_relationship(
            tenant_id=who.tenant_id,
            src_id=req.src_id,
            dst_id=req.dst_id,
            relation=req.relation,
            attributes=req.attributes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return asdict(edge)


def _repository():
    return get_assets_repository()
