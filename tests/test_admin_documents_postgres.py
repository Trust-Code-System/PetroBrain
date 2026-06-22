"""
Postgres backend integration tests for the admin_documents repository (006).

Runs only when ``PB_TEST_DATABASE_URL`` is set; skipped otherwise.
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
    from app.db.admin_document_repository import PostgresAdminDocumentRepository

    with pg.connect(pg.normalize_dsn(ADMIN_DSN)) as conn:
        conn.execute("TRUNCATE admin_documents")
    return PostgresAdminDocumentRepository(app_dsn)


def _create(repo, tenant_id="tenant-a", **kw):
    meta = {"document_id": "SOP-1", "title": "Kick SOP", "revision": "B",
            "jurisdiction": "NUPRC", "asset": "asset-a", "effective_date": "2026-01-01"}
    meta.update(kw.pop("metadata", {}))
    return repo.create(tenant_id=tenant_id, user_id="u1", metadata=meta,
                       filename="kick.pdf", content_type="application/pdf",
                       size_bytes=1234, object_key="t/kick.pdf", **kw)


def test_create_starts_queued_with_history(repo):
    rec = _create(repo)
    assert rec.status == "queued"
    assert rec.size_bytes == 1234
    assert rec.object_key == "t/kick.pdf"
    assert [h["status"] for h in rec.status_history] == ["queued"]
    assert rec.created_utc and rec.updated_utc


def test_status_state_machine_appends_history(repo):
    rec = _create(repo)
    repo.update_status(tenant_id="tenant-a", ingest_id=rec.ingest_id, status="extracting")
    repo.update_status(tenant_id="tenant-a", ingest_id=rec.ingest_id, status="embedding")
    done = repo.update_status(tenant_id="tenant-a", ingest_id=rec.ingest_id, status="done",
                              chunk_count=7)
    assert done["status"] == "done"
    assert done["chunk_count"] == 7
    assert [h["status"] for h in done["status_history"]] == [
        "queued", "extracting", "embedding", "done"
    ]
    assert done["updated_utc"] >= done["created_utc"]


def test_failed_status_records_reason(repo):
    rec = _create(repo)
    failed = repo.update_status(tenant_id="tenant-a", ingest_id=rec.ingest_id,
                                status="failed", failure_reason="bad pdf")
    assert failed["status"] == "failed"
    assert failed["failure_reason"] == "bad pdf"

    recovered = repo.update_status(
        tenant_id="tenant-a",
        ingest_id=rec.ingest_id,
        status="done",
        chunk_count=2,
    )
    assert recovered["status"] == "done"
    assert recovered["failure_reason"] is None


def test_invalid_status_and_missing_ingest(repo):
    rec = _create(repo)
    with pytest.raises(ValueError):
        repo.update_status(tenant_id="tenant-a", ingest_id=rec.ingest_id, status="bogus")
    with pytest.raises(KeyError):
        repo.update_status(tenant_id="tenant-a", ingest_id="nope", status="done")


def test_get_and_list_summary(repo):
    rec = _create(repo, metadata={"document_id": "SOP-1"})
    _create(repo, metadata={"document_id": "SOP-2"})
    full = repo.get(tenant_id="tenant-a", ingest_id=rec.ingest_id)
    assert full["object_key"] == "t/kick.pdf"
    assert "status_history" in full
    rows = repo.list_records(tenant_id="tenant-a")
    assert {r["document_id"] for r in rows} == {"SOP-1", "SOP-2"}
    assert all("status_history" not in r for r in rows)  # summary omits history
    assert all("status" in r for r in rows)


def test_tenant_isolation_and_rls(repo, app_dsn):
    a = _create(repo, tenant_id="tenant-a")
    _create(repo, tenant_id="tenant-b")
    assert repo.get(tenant_id="tenant-b", ingest_id=a.ingest_id) is None
    with pytest.raises(KeyError):
        repo.update_status(tenant_id="tenant-b", ingest_id=a.ingest_id, status="done")
    assert len(repo.list_records(tenant_id="tenant-a")) == 1

    import psycopg

    from app.db import pg

    with psycopg.connect(pg.normalize_dsn(app_dsn), autocommit=True) as conn:
        pg.set_tenant(conn, "tenant-a")
        seen = {r[0] for r in conn.execute("SELECT tenant_id FROM admin_documents").fetchall()}
    assert seen == {"tenant-a"}
