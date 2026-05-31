"""
Postgres backend integration tests for the tenants repository (Tier 2, 004).

Runs only when ``PB_TEST_DATABASE_URL`` points at a reachable Postgres; skipped
otherwise. The tenants table is the platform registry - its RLS is keyed on the
row ``id`` with a ``'*'`` platform-admin bypass - so the repo connects with the
GUC set to ``'*'``. A dedicated test proves the self-visibility policy directly.
"""
import os
import sys
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

ADMIN_DSN = os.getenv("PB_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not ADMIN_DSN,
    reason="PB_TEST_DATABASE_URL not set; Postgres integration tests skipped",
)

APP_ROLE = "petrobrain_app"
APP_PASSWORD = "apppw_test"  # noqa: S105 - test-only, ephemeral CI/dev database


def _app_dsn(admin_dsn: str) -> str:
    from app.db import pg

    parts = urlsplit(pg.normalize_dsn(admin_dsn))
    netloc = f"{APP_ROLE}:{APP_PASSWORD}@{parts.hostname}:{parts.port or 5432}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


@pytest.fixture(scope="module")
def app_dsn():
    from app.db import pg

    admin = pg.normalize_dsn(ADMIN_DSN)
    with pg.connect(admin) as conn:
        pg.apply_migrations(conn)
        conn.execute(
            f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{APP_ROLE}') "
            f"THEN CREATE ROLE {APP_ROLE} LOGIN PASSWORD '{APP_PASSWORD}' NOSUPERUSER; END IF; END $$;"
        )
        conn.execute(f"ALTER ROLE {APP_ROLE} LOGIN PASSWORD '{APP_PASSWORD}' NOSUPERUSER")
        conn.execute(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}")
        conn.execute(
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE}"
        )
        conn.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE}")
    return _app_dsn(ADMIN_DSN)


@pytest.fixture
def repo(app_dsn):
    from app.db import pg
    from app.db.tenants_repository import PostgresTenantsRepository

    with pg.connect(pg.normalize_dsn(ADMIN_DSN)) as conn:
        conn.execute("TRUNCATE tenants CASCADE")
    return PostgresTenantsRepository(app_dsn)


def test_create_and_get(repo):
    rec = repo.create(id="tenant-a", name="Operator A", attributes={"region": "ng"})
    assert rec.id == "tenant-a"
    assert rec.name == "Operator A"
    assert rec.status == "active"
    assert rec.attributes == {"region": "ng"}
    assert isinstance(rec.created_utc, str) and rec.created_utc
    got = repo.get("tenant-a")
    assert got["name"] == "Operator A"
    assert got["attributes"] == {"region": "ng"}


def test_create_duplicate_id_raises(repo):
    repo.create(id="tenant-a", name="A")
    with pytest.raises(ValueError):
        repo.create(id="tenant-a", name="A again")


def test_invalid_status_raises(repo):
    with pytest.raises(ValueError):
        repo.create(id="tenant-x", name="X", status="paused")


def test_list_filters_by_status_and_orders_by_created(repo):
    repo.create(id="tenant-a", name="A")
    repo.create(id="tenant-b", name="B", status="suspended")
    repo.create(id="tenant-c", name="C")
    all_ids = [r["id"] for r in repo.list_records()]
    assert all_ids == ["tenant-a", "tenant-b", "tenant-c"]  # created_utc order
    assert {r["id"] for r in repo.list_records(status="active")} == {"tenant-a", "tenant-c"}
    assert {r["id"] for r in repo.list_records(status="suspended")} == {"tenant-b"}


def test_update_fields_and_missing_raises(repo):
    repo.create(id="tenant-a", name="A")
    updated = repo.update("tenant-a", name="A Renamed", status="suspended",
                          attributes={"k": "v"})
    assert updated["name"] == "A Renamed"
    assert updated["status"] == "suspended"
    assert updated["attributes"] == {"k": "v"}
    assert updated["updated_utc"] >= updated["created_utc"]
    with pytest.raises(KeyError):
        repo.update("nope", name="x")


def test_update_rejects_bad_status_and_empty_name(repo):
    repo.create(id="tenant-a", name="A")
    with pytest.raises(ValueError):
        repo.update("tenant-a", status="paused")
    with pytest.raises(ValueError):
        repo.update("tenant-a", name="   ")


def test_rls_self_visibility_and_platform_bypass(repo, app_dsn):
    """The RLS policy lets a tenant see only its own row (GUC = its id) while
    the '*' GUC sees all rows - the platform-admin bypass the repo relies on."""
    import psycopg

    from app.db import pg

    repo.create(id="tenant-a", name="A")
    repo.create(id="tenant-b", name="B")
    with psycopg.connect(pg.normalize_dsn(app_dsn), autocommit=True) as conn:
        pg.set_tenant(conn, "tenant-a")
        scoped = {r[0] for r in conn.execute("SELECT id FROM tenants").fetchall()}
        pg.set_tenant(conn, pg.PLATFORM_ADMIN_TENANT)
        platform = {r[0] for r in conn.execute("SELECT id FROM tenants").fetchall()}
    assert scoped == {"tenant-a"}
    assert platform == {"tenant-a", "tenant-b"}
