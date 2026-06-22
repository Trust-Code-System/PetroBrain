"""
DB-layer tenant-isolation PROOF (live Postgres).

Unlike tests/test_tenant_isolation.py (which uses fakes to run in the normal suite), this
connects as the NON-superuser application role and demonstrates that the Row-Level Security
policies in app/db/migrations actually block cross-tenant reads and writes at the engine —
the backstop that survives any app-layer WHERE-clause bug. Superusers bypass RLS even under
FORCE, so proving it requires the NOSUPERUSER role (see app/db/pg.py).

Runs only when PB_TEST_DATABASE_URL is set (same gate + role-bootstrap pattern as the other
*_postgres.py suites). In CI the Postgres service supplies the DSN.
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
    """Apply migrations and provision the NOSUPERUSER app role RLS is tested against."""
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
def app_conn(app_dsn):
    """A fresh connection as the app role, with the assets table truncated for determinism."""
    from app.db import pg

    with pg.connect(pg.normalize_dsn(ADMIN_DSN)) as admin:
        admin.execute("TRUNCATE assets, asset_relationships CASCADE")
    conn = pg.connect(app_dsn)
    try:
        yield conn
    finally:
        conn.close()


def _insert_asset(conn, asset_id: str, tenant_id: str) -> None:
    conn.execute(
        "INSERT INTO assets (id, tenant_id, type, name) VALUES (%s, %s, %s, %s)",
        (asset_id, tenant_id, "field", "Niger-Delta"),
    )


def test_rls_blocks_cross_tenant_read(app_conn):
    from app.db import pg

    pg.set_tenant(app_conn, "tenant-a")
    _insert_asset(app_conn, "asset-a", "tenant-a")

    # tenant-b sees nothing, even with no WHERE filter — RLS is the gate, not the query.
    pg.set_tenant(app_conn, "tenant-b")
    assert app_conn.execute("SELECT id FROM assets").fetchall() == []

    # tenant-a sees its own row.
    pg.set_tenant(app_conn, "tenant-a")
    assert [r[0] for r in app_conn.execute("SELECT id FROM assets").fetchall()] == ["asset-a"]


def test_rls_blocks_cross_tenant_write(app_conn):
    import psycopg
    from app.db import pg

    # tenant-b tries to smuggle in a row labelled tenant-a → WITH CHECK rejects it.
    pg.set_tenant(app_conn, "tenant-b")
    with pytest.raises(psycopg.Error):
        _insert_asset(app_conn, "smuggled", "tenant-a")


def test_rls_blocks_cross_tenant_update_delete(app_conn):
    from app.db import pg

    # tenant-a owns the row.
    pg.set_tenant(app_conn, "tenant-a")
    _insert_asset(app_conn, "asset-a", "tenant-a")

    # tenant-b's UPDATE/DELETE see no rows to act on — RLS filters before the
    # WHERE, so a cross-tenant write silently affects 0 rows rather than another
    # tenant's data. (Complements the WITH CHECK insert proof above.)
    pg.set_tenant(app_conn, "tenant-b")
    assert app_conn.execute("UPDATE assets SET name = 'hacked'").rowcount == 0
    assert app_conn.execute("DELETE FROM assets").rowcount == 0

    # tenant-a's row is intact and unchanged.
    pg.set_tenant(app_conn, "tenant-a")
    assert [
        (r[0], r[1]) for r in app_conn.execute("SELECT id, name FROM assets").fetchall()
    ] == [("asset-a", "Niger-Delta")]


def test_rls_hides_rows_when_tenant_unset(app_conn):
    from app.db import pg

    pg.set_tenant(app_conn, "tenant-a")
    _insert_asset(app_conn, "asset-a2", "tenant-a")

    # An empty tenant GUC matches no tenant_id → fail-closed (nothing visible).
    app_conn.execute("SELECT set_config('petrobrain.tenant_id', '', false)")
    assert app_conn.execute("SELECT id FROM assets").fetchall() == []
