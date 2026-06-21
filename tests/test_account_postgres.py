"""
Postgres backend integration tests for the account repository (Group 1, 018).

Mirrors the LocalJson behaviours in tests/test_account.py against real Postgres,
exercising the row-level-security backstop with a NOSUPERUSER app role (same
pattern as tests/test_assets_postgres.py). Runs only when ``PB_TEST_DATABASE_URL``
is set.

Covers: default-on-first-read, upsert round-trip, cross-tenant isolation (a second
tenant can neither read nor patch the first's profile/settings), and the RLS
backstop (a raw unfiltered SELECT only sees the GUC tenant). The ``/org`` admin
gate is persistence-agnostic (it short-circuits in the route before any DB call)
and is covered in tests/test_account.py.
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
    from app.db.account_repository import PostgresAccountRepository

    with pg.connect(pg.normalize_dsn(ADMIN_DSN)) as conn:
        conn.execute("TRUNCATE user_settings, org_settings")
    return PostgresAccountRepository(app_dsn)


# ---- defaults on first read ---------------------------------------------

def test_user_settings_default_on_first_read(repo):
    us = repo.get_user_settings(tenant_id="tenant-a", user_id="u1")
    assert us["display_name"] == ""
    assert us["avatar_url"] is None
    assert us["units"] == "oilfield"
    assert us["language"] == "en"
    assert us["notifications"] == {"product": True, "reports": True, "alerts": True}
    assert us["opportunity_alerts"] is None


def test_org_settings_default_on_first_read(repo):
    org = repo.get_org_settings(tenant_id="tenant-a")
    assert org["company"] == ""
    assert org["segment"] == "upstream"
    assert org["reporting_boundary"] == "operational_control"
    assert org["gwp_set"] == "ar6"
    assert org["frameworks"] == []


# ---- upsert round-trips -------------------------------------------------

def test_user_settings_upsert_roundtrip(repo):
    repo.upsert_user_settings(
        tenant_id="tenant-a", user_id="u1",
        changes={
            "display_name": "Ada Lovelace",
            "units": "metric",
            "notifications": {"product": False, "reports": True, "alerts": False},
            "opportunity_alerts": {"newRoundCountries": ["NG"], "deadlineReminders": True},
        },
    )
    us = repo.get_user_settings(tenant_id="tenant-a", user_id="u1")
    assert us["display_name"] == "Ada Lovelace"
    assert us["units"] == "metric"
    assert us["notifications"]["product"] is False
    assert us["opportunity_alerts"]["newRoundCountries"] == ["NG"]

    # Second upsert is a partial update (shallow merge of provided columns only).
    repo.upsert_user_settings(
        tenant_id="tenant-a", user_id="u1", changes={"language": "pcm"},
    )
    us = repo.get_user_settings(tenant_id="tenant-a", user_id="u1")
    assert us["language"] == "pcm"
    assert us["display_name"] == "Ada Lovelace"  # untouched by the partial update


def test_org_settings_upsert_roundtrip(repo):
    repo.upsert_org_settings(
        tenant_id="tenant-a",
        changes={
            "company": "Acme Oil",
            "reporting_boundary": "equity_share",
            "gwp_set": "ar5",
            "frameworks": ["gri", "issb"],
        },
    )
    org = repo.get_org_settings(tenant_id="tenant-a")
    assert org["company"] == "Acme Oil"
    assert org["reporting_boundary"] == "equity_share"
    assert org["gwp_set"] == "ar5"
    assert org["frameworks"] == ["gri", "issb"]


# ---- tenant isolation ---------------------------------------------------

def test_user_settings_tenant_isolated(repo):
    repo.upsert_user_settings(
        tenant_id="tenant-a", user_id="u1", changes={"display_name": "A", "units": "metric"},
    )
    # Same user_id, different tenant -> defaults, never tenant-a's row.
    other = repo.get_user_settings(tenant_id="tenant-b", user_id="u1")
    assert other["display_name"] == ""
    assert other["units"] == "oilfield"

    # And a write under tenant-b creates a *separate* row; tenant-a is untouched.
    repo.upsert_user_settings(
        tenant_id="tenant-b", user_id="u1", changes={"display_name": "B"},
    )
    assert repo.get_user_settings(tenant_id="tenant-a", user_id="u1")["display_name"] == "A"
    assert repo.get_user_settings(tenant_id="tenant-b", user_id="u1")["display_name"] == "B"


def test_org_settings_tenant_isolated(repo):
    repo.upsert_org_settings(tenant_id="tenant-a", changes={"company": "Acme"})
    assert repo.get_org_settings(tenant_id="tenant-b")["company"] == ""


# ---- RLS backstop -------------------------------------------------------

def test_rls_backstop_user_settings(repo, app_dsn):
    repo.upsert_user_settings(tenant_id="tenant-a", user_id="u1", changes={"display_name": "A"})
    repo.upsert_user_settings(tenant_id="tenant-b", user_id="u1", changes={"display_name": "B"})

    import psycopg

    from app.db import pg

    # A raw unfiltered SELECT under the app role only sees the GUC tenant's rows,
    # even though both tenants have a row - FORCE ROW LEVEL SECURITY is the backstop.
    with psycopg.connect(pg.normalize_dsn(app_dsn), autocommit=True) as conn:
        pg.set_tenant(conn, "tenant-a")
        seen = {r[0] for r in conn.execute("SELECT tenant_id FROM user_settings").fetchall()}
    assert seen == {"tenant-a"}


def test_rls_backstop_org_settings(repo, app_dsn):
    repo.upsert_org_settings(tenant_id="tenant-a", changes={"company": "A"})
    repo.upsert_org_settings(tenant_id="tenant-b", changes={"company": "B"})

    import psycopg

    from app.db import pg

    with psycopg.connect(pg.normalize_dsn(app_dsn), autocommit=True) as conn:
        pg.set_tenant(conn, "tenant-b")
        seen = {r[0] for r in conn.execute("SELECT tenant_id FROM org_settings").fetchall()}
    assert seen == {"tenant-b"}
