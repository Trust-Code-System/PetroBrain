"""build_celery_app() broker/eager resolution.

The single-service demo deploys ship no Redis + worker. An empty broker must
fall back to eager (inline) execution rather than crashing every dispatch with
"No such transport: ''". A configured broker keeps async semantics unless the
operator explicitly forces eager.
"""
import os
import sys

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


def test_empty_broker_forces_eager(fresh_settings):
    app = fresh_settings({"PB_CELERY_BROKER_URL": "", "PB_CELERY_TASK_ALWAYS_EAGER": "false"})
    assert app.conf.task_always_eager is True
    assert app.conf.task_eager_propagates is True


def test_whitespace_only_broker_forces_eager(fresh_settings):
    app = fresh_settings({"PB_CELERY_BROKER_URL": "   ", "PB_CELERY_TASK_ALWAYS_EAGER": "false"})
    assert app.conf.task_always_eager is True


def test_configured_broker_stays_async(fresh_settings):
    app = fresh_settings(
        {"PB_CELERY_BROKER_URL": "redis://localhost:6379/1", "PB_CELERY_TASK_ALWAYS_EAGER": "false"}
    )
    assert app.conf.task_always_eager is False


def test_explicit_eager_overrides_configured_broker(fresh_settings):
    app = fresh_settings(
        {"PB_CELERY_BROKER_URL": "redis://localhost:6379/1", "PB_CELERY_TASK_ALWAYS_EAGER": "true"}
    )
    assert app.conf.task_always_eager is True
