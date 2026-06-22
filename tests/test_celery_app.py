"""build_celery_app() broker/backend/eager resolution."""
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.config import get_settings
from app.workers.celery_app import build_celery_app


@pytest.fixture
def fresh_settings(monkeypatch):
    """Rebuild Settings from a controlled environment for each case."""

    def _apply(env: dict[str, str]):
        for key in (
            "PB_CELERY_BROKER_URL",
            "PB_CELERY_RESULT_BACKEND",
            "PB_CELERY_TASK_ALWAYS_EAGER",
        ):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()
        return build_celery_app()

    try:
        yield _apply
    finally:
        get_settings.cache_clear()


def _register_add_task(app):
    task_name = f"tests.add.{uuid.uuid4()}"

    @app.task(name=task_name)
    def add(left: int, right: int) -> int:
        return left + right

    return add


def test_empty_broker_forces_eager(fresh_settings):
    app = fresh_settings({"PB_CELERY_BROKER_URL": "", "PB_CELERY_TASK_ALWAYS_EAGER": "false"})
    assert app.conf.broker_url == "memory://"
    assert app.conf.task_always_eager is True
    assert app.conf.task_eager_propagates is True


def test_whitespace_only_broker_forces_eager(fresh_settings):
    app = fresh_settings({"PB_CELERY_BROKER_URL": "   ", "PB_CELERY_TASK_ALWAYS_EAGER": "false"})
    assert app.conf.broker_url == "memory://"
    assert app.conf.task_always_eager is True


def test_schemeless_broker_forces_eager(fresh_settings):
    # A bare hostname (no redis:// scheme) is what produced "No such transport: ''"
    # in prod: non-empty, so the empty-check missed it, but kombu can't resolve it.
    app = fresh_settings(
        {"PB_CELERY_BROKER_URL": "red-abc123:6379", "PB_CELERY_TASK_ALWAYS_EAGER": "false"}
    )
    assert app.conf.broker_url == "memory://"
    assert app.conf.task_always_eager is True


def test_configured_broker_stays_async(fresh_settings):
    app = fresh_settings(
        {"PB_CELERY_BROKER_URL": "redis://localhost:6379/1", "PB_CELERY_TASK_ALWAYS_EAGER": "false"}
    )
    assert app.conf.broker_url == "redis://localhost:6379/1"
    assert app.conf.task_always_eager is False


def test_explicit_eager_overrides_configured_broker(fresh_settings):
    app = fresh_settings(
        {"PB_CELERY_BROKER_URL": "redis://localhost:6379/1", "PB_CELERY_TASK_ALWAYS_EAGER": "true"}
    )
    assert app.conf.broker_url == "redis://localhost:6379/1"
    assert app.conf.task_always_eager is True


def test_malformed_redis_cli_broker_falls_back_to_inline_memory_transport(fresh_settings):
    app = fresh_settings(
        {
            "PB_CELERY_BROKER_URL": "redis-cli --tls -u redis://example:6379/1",
            "PB_CELERY_RESULT_BACKEND": "cache+memory://",
            "PB_CELERY_TASK_ALWAYS_EAGER": "false",
        }
    )
    add = _register_add_task(app)

    assert app.conf.broker_url == "memory://"
    assert app.conf.task_always_eager is True
    assert add.delay(2, 3).get(timeout=1) == 5


def test_malformed_redis_cli_result_backend_falls_back_to_memory_backend(fresh_settings):
    app = fresh_settings(
        {
            "PB_CELERY_BROKER_URL": "memory://",
            "PB_CELERY_RESULT_BACKEND": "redis-cli --tls -u redis://example:6379/2",
            "PB_CELERY_TASK_ALWAYS_EAGER": "true",
        }
    )
    add = _register_add_task(app)

    assert app.conf.result_backend == "cache+memory://"
    assert add.delay(4, 6).get(timeout=1) == 10
