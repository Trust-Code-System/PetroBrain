"""
Celery application for PetroBrain async ingestion.

Tier-A spine runs Celery against Redis. Tier-B (on-prem) reuses the same
broker URL pointed at an in-DMZ Redis. The application object is exposed as
``celery_app`` so it can be run with ``celery -A app.workers.celery_app worker``.
"""
from __future__ import annotations

import logging

from celery import Celery

from app.config import get_settings
from app.core.redis_security import redis_ssl_options

logger = logging.getLogger("petrobrain.celery")

_SUPPORTED_BROKER_TRANSPORTS = frozenset({"redis", "rediss", "amqp", "amqps", "memory"})
_SUPPORTED_RESULT_BACKENDS = frozenset({"redis", "rediss", "rpc", "cache+memory"})
_FALLBACK_BROKER_URL = "memory://"
_FALLBACK_RESULT_BACKEND = "cache+memory://"


def build_celery_app() -> Celery:
    settings = get_settings()
    raw_broker_url = (settings.celery_broker_url or "").strip()
    # A publishable broker needs a transport scheme (redis://, rediss://, amqp://).
    # Empty, scheme-less, or command-shaped values (for example a pasted
    # "redis-cli --tls -u redis://..." command) resolve to bogus Kombu
    # transports and crash dispatch with errors such as
    # "No module named 'redis-cli --tls -u redis'". Production still requires
    # rediss:// via validate_production_settings; demo/single-service deploys
    # self-heal by using Celery's in-memory transport and running inline.
    broker_scheme = _transport_scheme(raw_broker_url, _SUPPORTED_BROKER_TRANSPORTS)
    invalid_broker = not broker_scheme
    broker_url = raw_broker_url if not invalid_broker else _FALLBACK_BROKER_URL
    eager = settings.celery_task_always_eager or invalid_broker
    if eager and not settings.celery_task_always_eager:
        logger.warning(
            "PB_CELERY_BROKER_URL has no supported transport scheme (%r); using "
            "%s and running ingestion inline (task_always_eager). Configure "
            "redis(s):// or amqp(s):// + a worker for async ingestion.",
            raw_broker_url or "<empty>",
            _FALLBACK_BROKER_URL,
        )
    result_backend = _result_backend_url(settings.celery_result_backend)
    app = Celery(
        "petrobrain",
        broker=broker_url,
        backend=result_backend,
        include=["app.workers.ingest_worker"],
    )
    app.conf.task_always_eager = eager
    app.conf.task_eager_propagates = eager
    app.conf.task_acks_late = True
    app.conf.task_default_queue = "petrobrain.ingest"
    app.conf.worker_max_tasks_per_child = 100
    app.conf.broker_connection_retry_on_startup = True
    broker_ssl = redis_ssl_options(broker_url, settings)
    if broker_ssl:
        app.conf.broker_use_ssl = broker_ssl
    backend_ssl = redis_ssl_options(result_backend, settings)
    if backend_ssl:
        app.conf.redis_backend_use_ssl = backend_ssl
    return app


def _result_backend_url(raw: str) -> str:
    backend_url = (raw or "").strip()
    if _transport_scheme(backend_url, _SUPPORTED_RESULT_BACKENDS):
        return backend_url
    if backend_url:
        logger.warning(
            "PB_CELERY_RESULT_BACKEND has no supported backend scheme (%r); using %s.",
            backend_url,
            _FALLBACK_RESULT_BACKEND,
        )
    return _FALLBACK_RESULT_BACKEND


def _transport_scheme(url: str, supported: frozenset[str]) -> str:
    if "://" not in url:
        return ""
    scheme = url.split("://", 1)[0].strip().lower()
    return scheme if scheme in supported else ""


celery_app = build_celery_app()
