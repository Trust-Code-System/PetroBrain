"""
Per-tenant chunk weights for retrieval re-ranking (slice 3 of the learning loop).

Read-heavy (every chat turn that retrieves N chunks reads N weights),
write-light (one update per 👍/👎). Stored in Postgres in production with the
RLS policy from migration 013; LocalJson backend mirrors the API for dev.

The weight is BOUNDED in [chunk_weight_floor, chunk_weight_ceiling] (defaults
0.5 and 1.5). The floor is the safety property: heavy negative feedback can
demote a chunk by 50% but cannot remove it from retrieval. The retriever
applies weight as a multiplier on the post-fusion score.

This repository is read-then-multiply pure data; the actual feedback ->
weight propagation lives in app.core.chunk_weight_updater so the policy
(asymmetric step sizes, attribution lookup) can be tested separately.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from app.config import get_settings


@dataclass
class ChunkWeightRecord:
    tenant_id: str
    chunk_id: int
    weight: float
    up_count: int
    down_count: int
    last_updated: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clamp(weight: float) -> float:
    settings = get_settings()
    return max(
        settings.chunk_weight_floor,
        min(settings.chunk_weight_ceiling, float(weight)),
    )


class LocalJsonChunkWeightsRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def get_weights(
        self, *, tenant_id: str, chunk_ids: list[int],
    ) -> dict[int, float]:
        if not chunk_ids:
            return {}
        rows = self._read_all()
        return {
            int(r["chunk_id"]): float(r["weight"])
            for r in rows
            if r["tenant_id"] == tenant_id and int(r["chunk_id"]) in set(chunk_ids)
        }

    def bump(
        self, *, tenant_id: str, chunk_id: int, multiplier: float,
        rating: str,
    ) -> ChunkWeightRecord:
        if rating not in {"up", "down"}:
            raise ValueError(f"rating must be 'up' or 'down', got {rating!r}")
        with self._lock:
            rows = self._read_all_locked()
            row = next(
                (r for r in rows
                 if r["tenant_id"] == tenant_id and int(r["chunk_id"]) == chunk_id),
                None,
            )
            now = _now()
            if row is None:
                new_weight = _clamp(1.0 * multiplier)
                record = ChunkWeightRecord(
                    tenant_id=tenant_id, chunk_id=int(chunk_id),
                    weight=new_weight,
                    up_count=(1 if rating == "up" else 0),
                    down_count=(1 if rating == "down" else 0),
                    last_updated=now,
                )
                rows.append(record.as_dict())
            else:
                row["weight"] = _clamp(float(row["weight"]) * multiplier)
                if rating == "up":
                    row["up_count"] = int(row.get("up_count", 0)) + 1
                else:
                    row["down_count"] = int(row.get("down_count", 0)) + 1
                row["last_updated"] = now
                record = ChunkWeightRecord(**row)
            self._write_all_locked(rows)
            return record

    def list_records(
        self, *, tenant_id: str, limit: int = 200, offset: int = 0,
    ) -> list[dict[str, Any]]:
        rows = [r for r in self._read_all() if r["tenant_id"] == tenant_id]
        rows.sort(key=lambda r: float(r["weight"]))
        return rows[offset: offset + limit]

    def _read_all(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_all_locked()

    def _read_all_locked(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        out: list[dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def _write_all_locked(self, rows: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, sort_keys=True) + "\n")


class PostgresChunkWeightsRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def get_weights(
        self, *, tenant_id: str, chunk_ids: list[int],
    ) -> dict[int, float]:
        if not chunk_ids:
            return {}
        with _pg_tenant(tenant_id, self.dsn) as conn:
            rows = conn.execute(
                "SELECT chunk_id, weight FROM tenant_chunk_weights "
                "WHERE tenant_id = %s AND chunk_id = ANY(%s)",
                (tenant_id, list(chunk_ids)),
            ).fetchall()
        return {int(r["chunk_id"]): float(r["weight"]) for r in rows}

    def bump(
        self, *, tenant_id: str, chunk_id: int, multiplier: float,
        rating: str,
    ) -> ChunkWeightRecord:
        if rating not in {"up", "down"}:
            raise ValueError(f"rating must be 'up' or 'down', got {rating!r}")
        settings = get_settings()
        # Server-side clamp via greatest()/least(); INSERT new row at 1.0 *
        # multiplier on first feedback, otherwise multiply the existing weight.
        with _pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(
                "INSERT INTO tenant_chunk_weights "
                "(tenant_id, chunk_id, weight, up_count, down_count) "
                "VALUES (%s, %s, GREATEST(%s, LEAST(%s, %s)), %s, %s) "
                "ON CONFLICT (tenant_id, chunk_id) DO UPDATE SET "
                "weight = GREATEST(%s, LEAST(%s, "
                "tenant_chunk_weights.weight * %s)), "
                "up_count = tenant_chunk_weights.up_count + EXCLUDED.up_count, "
                "down_count = tenant_chunk_weights.down_count + EXCLUDED.down_count, "
                "last_updated = now() "
                "RETURNING tenant_id, chunk_id, weight, up_count, down_count, last_updated",
                (
                    tenant_id, int(chunk_id),
                    settings.chunk_weight_floor, settings.chunk_weight_ceiling,
                    1.0 * float(multiplier),
                    1 if rating == "up" else 0,
                    1 if rating == "down" else 0,
                    settings.chunk_weight_floor, settings.chunk_weight_ceiling,
                    float(multiplier),
                ),
            ).fetchone()
        out = dict(row)
        if isinstance(out.get("last_updated"), datetime):
            out["last_updated"] = out["last_updated"].isoformat()
        out["chunk_id"] = int(out["chunk_id"])
        out["weight"] = float(out["weight"])
        return ChunkWeightRecord(**out)

    def list_records(
        self, *, tenant_id: str, limit: int = 200, offset: int = 0,
    ) -> list[dict[str, Any]]:
        with _pg_tenant(tenant_id, self.dsn) as conn:
            rows = conn.execute(
                "SELECT tenant_id, chunk_id, weight, up_count, down_count, "
                "last_updated FROM tenant_chunk_weights "
                "WHERE tenant_id = %s "
                "ORDER BY weight ASC LIMIT %s OFFSET %s",
                (tenant_id, limit, offset),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            d["chunk_id"] = int(d["chunk_id"])
            d["weight"] = float(d["weight"])
            if isinstance(d.get("last_updated"), datetime):
                d["last_updated"] = d["last_updated"].isoformat()
            out.append(d)
        return out


def _pg_tenant(tenant_id: str, dsn: str | None):
    from app.db import pg

    return pg.tenant_connection(tenant_id, dsn=dsn, dict_rows=True)


def get_chunk_weights_repository():
    settings = get_settings()
    if settings.persistence_backend == "postgres":
        return PostgresChunkWeightsRepository(settings.database_url)
    return LocalJsonChunkWeightsRepository(settings.chunk_weight_store_path)
