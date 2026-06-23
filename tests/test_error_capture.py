"""Server-side automatic error capture: any qualifying failure an authenticated
user hits lands in the per-tenant error feed (with user-safe message + a
server-side error_detail) so the admin sees it, without the frontend reporting."""
import os
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.deps import Principal
from app.core import error_capture
from app.core.error_capture import (
    error_capture_middleware,
    should_capture,
    stash_http_detail,
    user_message,
)
from app.db.error_events_repository import LocalJsonErrorEventsRepository

PRINCIPAL = Principal(tenant_id="t1", user_id="u1", role="engineer", allowed_assets=["*"])


@pytest.fixture(autouse=True)
def _clean_dedupe():
    error_capture.reset_dedupe_cache()
    yield
    error_capture.reset_dedupe_cache()


# ---- scope -------------------------------------------------------------------

def test_should_capture_scope():
    # 5xx + exceptions always
    assert should_capture(500)
    assert should_capture(503)
    assert should_capture(200, had_exception=True)
    # genuine 4xx
    assert should_capture(400)
    assert should_capture(403)
    assert should_capture(409)
    assert should_capture(429)
    # routine noise skipped
    assert not should_capture(401)
    assert not should_capture(404)
    assert not should_capture(422)
    # success
    assert not should_capture(200)


def test_user_message_hides_5xx_detail_but_keeps_4xx_detail():
    # A 5xx never surfaces raw text to the user-facing message field.
    assert "wrong on our end" in user_message(500, "ValueError: secret db dsn leaked").lower()
    # A 4xx detail is what the user saw, so keep it.
    assert user_message(409, "asset already exists") == "asset already exists"
    # Unknown 4xx with no detail falls back to a generic line.
    assert "HTTP 418" in user_message(418, None)


# ---- capture writes a row ----------------------------------------------------

def _repo_at(tmp_path) -> LocalJsonErrorEventsRepository:
    return LocalJsonErrorEventsRepository(tmp_path / "error_events.jsonl")


def _build_app(monkeypatch, tmp_path):
    repo = _repo_at(tmp_path)
    monkeypatch.setattr(error_capture, "get_error_events_repository", lambda: repo)

    async def _fake_principal(_request):
        return PRINCIPAL

    monkeypatch.setattr(error_capture, "_resolve_principal", _fake_principal)

    app = FastAPI()
    app.middleware("http")(error_capture_middleware)
    app.add_exception_handler(StarletteHTTPException, stash_http_detail)

    @app.get("/boom")
    async def boom():
        raise RuntimeError("Error code: 429 - insufficient_quota billing leak")

    @app.get("/conflict")
    async def conflict():
        from fastapi import HTTPException

        raise HTTPException(status_code=409, detail="asset already exists")

    @app.get("/missing")
    async def missing():
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="nope")

    @app.get("/ok")
    async def ok():
        return {"ok": True}

    return app, repo


def test_unhandled_exception_is_captured_with_safe_message_and_detail(monkeypatch, tmp_path):
    app, repo = _build_app(monkeypatch, tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.get("/boom")
    assert resp.status_code == 500

    rows = repo.list_records(tenant_id="t1")
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == 500
    assert row["route"] == "/boom"
    # User-facing message is generic - raw provider/billing text never leaks here.
    assert "billing" not in row["message"].lower()
    assert "429" not in row["message"]
    # ...but the admin gets the real error in metadata.
    assert "RuntimeError" in row["metadata"]["error_detail"]
    assert row["metadata"]["exception_type"] == "RuntimeError"
    assert row["metadata"]["source"] == "server"
    assert row["metadata"]["method"] == "GET"


def test_genuine_4xx_is_captured_with_its_detail(monkeypatch, tmp_path):
    app, repo = _build_app(monkeypatch, tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/conflict").status_code == 409
    rows = repo.list_records(tenant_id="t1")
    assert len(rows) == 1
    assert rows[0]["status"] == 409
    assert rows[0]["message"] == "asset already exists"


def test_routine_404_and_success_are_not_captured(monkeypatch, tmp_path):
    app, repo = _build_app(monkeypatch, tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/missing").status_code == 404
    assert client.get("/ok").status_code == 200
    assert repo.list_records(tenant_id="t1") == []


def test_dedupe_collapses_identical_errors(monkeypatch, tmp_path):
    app, repo = _build_app(monkeypatch, tmp_path)
    client = TestClient(app, raise_server_exceptions=False)

    for _ in range(5):
        client.get("/boom")
    assert len(repo.list_records(tenant_id="t1")) == 1


def test_anonymous_request_is_not_captured(monkeypatch, tmp_path):
    repo = _repo_at(tmp_path)
    monkeypatch.setattr(error_capture, "get_error_events_repository", lambda: repo)

    async def _no_principal(_request):
        return None

    monkeypatch.setattr(error_capture, "_resolve_principal", _no_principal)

    app = FastAPI()
    app.middleware("http")(error_capture_middleware)

    @app.get("/boom")
    async def boom():
        raise RuntimeError("kaboom")

    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/boom").status_code == 500
    assert repo.list_records(tenant_id="t1") == []


def test_capture_disabled_via_settings(monkeypatch, tmp_path):
    app, repo = _build_app(monkeypatch, tmp_path)

    from types import SimpleNamespace

    monkeypatch.setattr(
        error_capture, "get_settings",
        lambda: SimpleNamespace(error_capture_enabled=False, error_capture_dedupe_seconds=60),
    )
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/boom").status_code == 500
    assert repo.list_records(tenant_id="t1") == []
