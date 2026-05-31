"""
Postgres backend integration tests for the users repository (Tier 2 reference).

These are the template for porting the remaining repositories. They run only
when ``PB_TEST_DATABASE_URL`` points at a reachable Postgres (CI provides a
``postgres`` service); otherwise the whole module is skipped, so the default
local_json test run is unaffected.

``PB_TEST_DATABASE_URL`` is an ADMIN/superuser DSN used for setup (migrations,
role creation, truncation). The repository under test connects as a dedicated
NOSUPERUSER role so the RLS policies are actually exercised - superusers bypass
RLS even under FORCE ROW LEVEL SECURITY.
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
    """Apply migrations and provision the NOSUPERUSER app role; return its DSN."""
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
        # BIGSERIAL columns (e.g. audit_events.id) need sequence USAGE to INSERT.
        conn.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE}")
    return _app_dsn(ADMIN_DSN)


@pytest.fixture
def repo(app_dsn):
    """Clean the tables, seed two tenants, return a repo on the app-role DSN."""
    from app.db import pg
    from app.db.users_repository import PostgresUsersRepository

    with pg.connect(pg.normalize_dsn(ADMIN_DSN)) as conn:
        conn.execute("TRUNCATE users, tenants CASCADE")
        conn.execute("INSERT INTO tenants (id, name) VALUES ('tenant-a', 'A'), ('tenant-b', 'B')")
    return PostgresUsersRepository(app_dsn)


def test_invite_returns_record_with_iso_timestamps(repo):
    user = repo.invite(tenant_id="tenant-a", email="alice@op.com", role="engineer",
                       allowed_assets=["eq-1"])
    assert user.tenant_id == "tenant-a"
    assert user.email == "alice@op.com"
    assert user.role == "engineer"
    assert user.status == "invited"
    assert user.allowed_assets == ["eq-1"]
    assert isinstance(user.invited_at_utc, str) and user.invited_at_utc  # serialized to ISO
    assert user.last_active_utc is None


def test_get_and_list_are_tenant_scoped(repo):
    a = repo.invite(tenant_id="tenant-a", email="alice@op.com", role="engineer")
    repo.invite(tenant_id="tenant-b", email="bob@op.com", role="hse")
    assert repo.get(tenant_id="tenant-a", user_id=a.id)["email"] == "alice@op.com"
    assert {r["email"] for r in repo.list_records(tenant_id="tenant-a")} == {"alice@op.com"}
    assert repo.count(tenant_id="tenant-a") == 1
    assert repo.count(tenant_id="tenant-b") == 1


def test_list_filters_by_status_and_role(repo):
    a = repo.invite(tenant_id="tenant-a", email="a@op.com", role="engineer")
    repo.invite(tenant_id="tenant-a", email="b@op.com", role="hse")
    repo.set_status(tenant_id="tenant-a", user_id=a.id, status="active")
    assert {r["email"] for r in repo.list_records(tenant_id="tenant-a", status="active")} == {"a@op.com"}
    assert {r["email"] for r in repo.list_records(tenant_id="tenant-a", role="hse")} == {"b@op.com"}


def test_set_role_status_and_allowed_assets(repo):
    u = repo.invite(tenant_id="tenant-a", email="a@op.com", role="engineer")
    repo.set_role(tenant_id="tenant-a", user_id=u.id, role="admin")
    repo.set_status(tenant_id="tenant-a", user_id=u.id, status="active")
    updated = repo.set_allowed_assets(tenant_id="tenant-a", user_id=u.id,
                                      allowed_assets=["eq-7", "eq-8"])
    assert updated["role"] == "admin"
    assert updated["status"] == "active"
    assert updated["allowed_assets"] == ["eq-7", "eq-8"]
    assert updated["updated_utc"] >= updated["invited_at_utc"]


def test_duplicate_email_raises_value_error(repo):
    repo.invite(tenant_id="tenant-a", email="dup@op.com", role="engineer")
    with pytest.raises(ValueError):
        repo.invite(tenant_id="tenant-a", email="dup@op.com", role="field")
    # same email under a different tenant is allowed
    repo.invite(tenant_id="tenant-b", email="dup@op.com", role="field")


def test_invalid_role_and_status_raise(repo):
    with pytest.raises(ValueError):
        repo.invite(tenant_id="tenant-a", email="x@op.com", role="superuser")
    u = repo.invite(tenant_id="tenant-a", email="y@op.com", role="engineer")
    with pytest.raises(ValueError):
        repo.set_status(tenant_id="tenant-a", user_id=u.id, status="banned")


def test_cross_tenant_access_is_blocked(repo):
    u = repo.invite(tenant_id="tenant-a", email="alice@op.com", role="engineer")
    assert repo.get(tenant_id="tenant-b", user_id=u.id) is None
    with pytest.raises(KeyError):
        repo.set_role(tenant_id="tenant-b", user_id=u.id, role="admin")


def test_rls_policy_blocks_cross_tenant_reads(repo, app_dsn):
    """Defense-in-depth: even a raw unfiltered SELECT by the app role only
    returns the GUC tenant's rows, proving the RLS policy (not just the app
    code's WHERE clause) enforces isolation."""
    import psycopg

    from app.db import pg

    repo.invite(tenant_id="tenant-a", email="alice@op.com", role="engineer")
    repo.invite(tenant_id="tenant-b", email="bob@op.com", role="hse")
    with psycopg.connect(pg.normalize_dsn(app_dsn), autocommit=True) as conn:
        pg.set_tenant(conn, "tenant-a")
        tenants_seen = {r[0] for r in conn.execute("SELECT tenant_id FROM users").fetchall()}
    assert tenants_seen == {"tenant-a"}
