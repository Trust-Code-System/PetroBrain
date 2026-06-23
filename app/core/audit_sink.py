"""
Off-host immutable audit copy (Option A).

The durable ``audit_events`` table is append-only + ``REVOKE UPDATE/DELETE``
(migration 002) but it is not hash-chained, and it lives on the same host the
app can write. This module ships an independent, immutable copy of every audit
row off-host to a dedicated CloudWatch Logs group, where a privileged attacker
on the app host cannot reach it. It is the Phase-2 follow-up named in
``app/core/audit.py``'s docstring.

Two contracts, both load-bearing:

1. **Best-effort, never raises into the request path.** A CloudWatch outage,
   a missing permission, or a throttle must never turn a successful audit append
   into a failed user request. Every failure is swallowed here.

2. **A swallowed failure is not a silent failure.** When the off-host copy can't
   be written (or when a durable append itself fails), we emit a greppable
   ``audit_write_failed`` ERROR to stdout -> CloudWatch, where a metric filter +
   alarm (infra/modules/alerting) pages on-call. "Actions are happening without
   being recorded" is exactly the condition we must not miss.

Audit rows are hash-only (request_hash/response_hash + metadata, no raw user
text - enforced by the audit module contract), so shipping them off-host is safe.
"""
from __future__ import annotations

import json
import logging
import os
import socket
from threading import Lock
from typing import Any

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Greppable stdout marker. infra/modules/alerting metric-filters this exact
# token; keep it in sync with that filter's `pattern`.
AUDIT_WRITE_FAILED_MARKER = "audit_write_failed"


def note_audit_write_failed(
    *,
    reason: str,
    tenant_id: str = "",
    user_id: str = "",
    action: str = "",
    audit_id: Any = "",
) -> None:
    """Emit the out-of-band ``audit_write_failed`` marker (ids/hashes only).

    Used both when a durable audit append raises (DB down / permission denied)
    and when the off-host CloudWatch copy fails. Never raises."""
    try:
        logger.error(
            "%s reason=%s tenant=%s user=%s action=%s audit_id=%s",
            AUDIT_WRITE_FAILED_MARKER, reason, tenant_id, user_id, action, audit_id,
        )
    except Exception:  # noqa: BLE001 - logging itself must not break the caller
        pass


class CloudWatchAuditSink:
    """Ships audit rows to a CloudWatch Logs group via ``logs:PutLogEvents``.

    Lazily creates a single per-process log stream and caches the sequence
    token. All AWS/boto3 errors are caught and converted into an
    ``audit_write_failed`` marker - the sink never raises."""

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self._enabled = bool(settings.audit_cloudwatch_enabled)
        self._group = settings.audit_cloudwatch_log_group or ""
        self._region = settings.audit_cloudwatch_region or settings.sovereign_region
        # One stream per process so concurrent tasks don't fight over a shared
        # sequence token. Name is stable for a process lifetime.
        self._stream = f"audit-{socket.gethostname()}-{os.getpid()}"
        self._client = client
        self._stream_ready = False
        self._sequence_token: str | None = None
        self._lock = Lock()

    @property
    def enabled(self) -> bool:
        return self._enabled and bool(self._group)

    def _get_client(self) -> Any:
        if self._client is None:
            import boto3  # lazy: only needed when the sink is enabled

            self._client = boto3.client("logs", region_name=self._region or None)
        return self._client

    def _ensure_stream(self, client: Any) -> None:
        if self._stream_ready:
            return
        try:
            client.create_log_stream(
                logGroupName=self._group, logStreamName=self._stream
            )
        except Exception as exc:  # noqa: BLE001
            # ResourceAlreadyExists is the normal steady-state path; any other
            # error (e.g. missing group/permission) surfaces on put_log_events.
            if type(exc).__name__ != "ResourceAlreadyExistsException":
                raise
        self._stream_ready = True

    def emit(self, record: dict[str, Any]) -> None:
        if not self.enabled:
            return
        with self._lock:
            try:
                client = self._get_client()
                self._ensure_stream(client)
                self._sequence_token = self._put(client, record)
            except Exception as exc:  # noqa: BLE001 - best-effort, never raise
                note_audit_write_failed(
                    reason=f"cloudwatch_emit_failed:{type(exc).__name__}",
                    tenant_id=str(record.get("tenant_id", "")),
                    user_id=str(record.get("user_id", "")),
                    action=str(record.get("action", "")),
                    audit_id=record.get("id", ""),
                )

    def _put(self, client: Any, record: dict[str, Any]) -> str | None:
        kwargs: dict[str, Any] = {
            "logGroupName": self._group,
            "logStreamName": self._stream,
            "logEvents": [
                {
                    "timestamp": _event_timestamp_ms(record),
                    "message": json.dumps(record, sort_keys=True, default=str),
                }
            ],
        }
        if self._sequence_token is not None:
            kwargs["sequenceToken"] = self._sequence_token
        try:
            resp = client.put_log_events(**kwargs)
        except Exception as exc:  # noqa: BLE001
            # A stale/absent sequence token is recoverable: AWS returns the
            # expected token on the exception. Retry exactly once with it.
            expected = getattr(exc, "expected_sequence_token", None) or _expected_token(exc)
            if expected is None or type(exc).__name__ not in {
                "InvalidSequenceTokenException",
                "DataAlreadyAcceptedException",
            }:
                raise
            kwargs["sequenceToken"] = expected
            resp = client.put_log_events(**kwargs)
        return resp.get("nextSequenceToken") if isinstance(resp, dict) else None


def _event_timestamp_ms(record: dict[str, Any]) -> int:
    from datetime import datetime, timezone

    ts = record.get("ts")
    if isinstance(ts, str) and ts:
        try:
            return int(datetime.fromisoformat(ts).timestamp() * 1000)
        except ValueError:
            pass
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _expected_token(exc: Exception) -> str | None:
    """Pull the expected sequence token out of a botocore client error."""
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        token = resp.get("expectedSequenceToken")
        if isinstance(token, str):
            return token
    return None


_sink: CloudWatchAuditSink | None = None
_sink_lock = Lock()


def _get_sink() -> CloudWatchAuditSink:
    global _sink
    if _sink is None:
        with _sink_lock:
            if _sink is None:
                _sink = CloudWatchAuditSink(get_settings())
    return _sink


def emit_audit_row(record: dict[str, Any]) -> None:
    """Best-effort off-host copy of one durable audit row. Never raises.

    No-op unless ``PB_AUDIT_CLOUDWATCH_ENABLED`` is set and a log group is
    configured, so dev/tests/the demo are unaffected."""
    try:
        _get_sink().emit(record)
    except Exception:  # noqa: BLE001 - the whole point is to never break append()
        note_audit_write_failed(
            reason="audit_sink_unexpected",
            tenant_id=str(record.get("tenant_id", "")),
            user_id=str(record.get("user_id", "")),
            action=str(record.get("action", "")),
            audit_id=record.get("id", ""),
        )


def reset_audit_sink_cache() -> None:
    """Drop the cached sink so the next emit rebuilds it from current settings
    (used by tests that flip the CloudWatch flag)."""
    global _sink
    with _sink_lock:
        _sink = None
