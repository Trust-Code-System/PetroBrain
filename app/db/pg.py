"""
Postgres backend helpers (sync psycopg3).

Shared by the Postgres repository variants. Connection-per-call mirrors the
stateless LocalJson repos; a pool is a later optimization (see the persistence
roadmap). Tenant isolation is enforced two ways, defence in depth:

  1. every query filters on ``tenant_id`` explicitly - correct regardless of the
     connecting DB role; and
  2. each connection sets the ``petrobrain.tenant_id`` GUC so the Row-Level
     Security policies in ``app/db/migrations`` are the backstop.

For RLS to actually bite, the connecting role must NOT be a superuser or hold
BYPASSRLS (superusers bypass RLS even under ``FORCE ROW LEVEL SECURITY``). Use a
dedicated NOSUPERUSER application role in any environment where RLS matters.
"""
from __future__ import annotations

import atexit
import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

from app.config import get_settings

if TYPE_CHECKING:  # pragma: no cover - typing only
    from psycopg import Connection

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

# SQLAlchemy-style DSNs ("postgresql+asyncpg://…") carry a driver suffix that
# libpq / psycopg does not understand; strip it to a plain libpq DSN.
_DRIVER_RE = re.compile(r"^(postgresql|postgres)\+\w+://")
TENANT_GUC = "petrobrain.tenant_id"
PLATFORM_ADMIN_TENANT = "*"


def normalize_dsn(url: str) -> str:
    """Return a libpq-compatible DSN, dropping any '+driver' suffix."""
    return _DRIVER_RE.sub("postgresql://", url)


def _psycopg():
    try:
        import psycopg
    except ModuleNotFoundError as exc:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "psycopg is required for PB_PERSISTENCE_BACKEND=postgres. "
            "Install it with: pip install 'psycopg[binary]'"
        ) from exc
    return psycopg


def connect(dsn: str | None = None, *, autocommit: bool = True) -> "Connection":
    """Open a NON-pooled psycopg connection. Used for migrations / one-off DDL;
    request-path repository access goes through the pool (tenant_connection)."""
    psycopg = _psycopg()
    resolved = normalize_dsn(dsn or get_settings().database_url)
    return psycopg.connect(resolved, autocommit=autocommit)


# One connection pool per resolved DSN, created lazily and reused for process
# lifetime. Pooling avoids a TCP+TLS+auth handshake on every repository call.
_pools: dict[str, Any] = {}


def _get_pool(dsn: str | None):
    resolved = normalize_dsn(dsn or get_settings().database_url)
    pool = _pools.get(resolved)
    if pool is None:
        try:
            from psycopg_pool import ConnectionPool
        except ModuleNotFoundError as exc:  # pragma: no cover - dependency guard
            raise RuntimeError(
                "psycopg[pool] is required for PB_PERSISTENCE_BACKEND=postgres. "
                "Install it with: pip install 'psycopg[binary,pool]'"
            ) from exc
        max_size = int(os.getenv("PB_DB_POOL_MAX_SIZE", "10"))
        pool = ConnectionPool(
            resolved, min_size=1, max_size=max_size,
            kwargs={"autocommit": True}, open=False, name=f"petrobrain-{len(_pools)}",
        )
        pool.open()
        _pools[resolved] = pool
    return pool


@atexit.register
def _close_pools() -> None:  # pragma: no cover - process teardown
    for pool in _pools.values():
        try:
            pool.close()
        except Exception:
            pass
    _pools.clear()


def set_tenant(conn: "Connection", tenant_id: str) -> None:
    """Set the session GUC consulted by the RLS policies. '*' = platform bypass."""
    conn.execute(f"SELECT set_config('{TENANT_GUC}', %s, false)", (tenant_id,))


@contextmanager
def tenant_connection(tenant_id: str, *, dsn: str | None = None,
                      autocommit: bool = True,
                      dict_rows: bool = False) -> Iterator["Connection"]:
    """Borrow a pooled connection with the tenant GUC set, returning it to the
    pool on exit.

    RLS-safe with pooling: this is the only path repositories use to obtain a
    connection, and it sets ``petrobrain.tenant_id`` (and the row factory)
    BEFORE yielding, so a reused connection can never serve the previous
    tenant's rows. ``dict_rows=True`` returns column-keyed dict rows.
    ``autocommit`` is governed by the pool (always True); the parameter is kept
    for call-site compatibility."""
    from psycopg.rows import dict_row, tuple_row

    pool = _get_pool(dsn)
    with pool.connection() as conn:
        conn.row_factory = dict_row if dict_rows else tuple_row  # type: ignore[assignment]
        set_tenant(conn, tenant_id)
        yield conn


def bootstrap_schema(conn: "Connection") -> None:
    """Create the pgvector extension + ``doc_chunks`` table the .sql migrations
    assume already exist. The DDL is owned by the RAG layer (vectorstore.SCHEMA);
    migration 001 only layers RLS onto ``doc_chunks``."""
    from app.rag.vectorstore import SCHEMA

    conn.execute(SCHEMA)  # type: ignore[arg-type]


def apply_migrations(conn: "Connection", *, migrations_dir: Path | None = None,
                     bootstrap: bool = True) -> list[str]:
    """Apply every ``*.sql`` migration in lexical order. Migrations are written
    idempotently (IF NOT EXISTS / DROP POLICY IF EXISTS) so re-running is safe.
    ``bootstrap`` first creates the base ``doc_chunks`` schema that 001 expects."""
    directory = migrations_dir or MIGRATIONS_DIR
    applied: list[str] = []
    if bootstrap:
        bootstrap_schema(conn)
    for path in sorted(directory.glob("*.sql")):
        # libpq simple-query protocol runs the whole multi-statement script.
        conn.execute(path.read_text(encoding="utf-8"))  # type: ignore[arg-type]
        applied.append(path.name)
    return applied


def run_migrations(dsn: str | None = None) -> list[str]:
    """Convenience entrypoint: open a connection and apply all migrations."""
    with connect(dsn) as conn:
        return apply_migrations(conn)


if __name__ == "__main__":  # pragma: no cover - ops convenience
    print("applied:", run_migrations())
