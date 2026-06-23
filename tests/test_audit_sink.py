"""Off-host immutable audit copy (Option A): the CloudWatch sink ships rows when
enabled, no-ops when disabled, and never raises into the request path - a failure
turns into the greppable ``audit_write_failed`` marker instead."""
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings
from app.core.audit_sink import (
    CloudWatchAuditSink,
    emit_audit_row,
    note_audit_write_failed,
    reset_audit_sink_cache,
)

ROW = {
    "id": 7,
    "ts": "2026-06-23T10:00:00+00:00",
    "tenant_id": "t1",
    "user_id": "u1",
    "action": "chat",
    "module": "well_control",
    "request_hash": "a" * 64,
    "response_hash": "b" * 64,
}


class FakeLogsClient:
    """Records put_log_events / create_log_stream calls; configurable failure."""

    def __init__(self, *, put_raises=None, next_token="tok-1"):
        self.put_calls = []
        self.create_calls = []
        self._put_raises = put_raises
        self._next_token = next_token

    def create_log_stream(self, **kwargs):
        self.create_calls.append(kwargs)

    def put_log_events(self, **kwargs):
        self.put_calls.append(kwargs)
        if self._put_raises is not None:
            raise self._put_raises
        return {"nextSequenceToken": self._next_token}


def _settings(**over):
    base = dict(
        audit_cloudwatch_enabled=True,
        audit_cloudwatch_log_group="/petrobrain/dev/audit",
        audit_cloudwatch_region="af-south-1",
    )
    base.update(over)
    return Settings(**base)


def test_enabled_emits_put_log_events():
    client = FakeLogsClient()
    sink = CloudWatchAuditSink(_settings(), client=client)
    sink.emit(ROW)
    assert len(client.put_calls) == 1
    call = client.put_calls[0]
    assert call["logGroupName"] == "/petrobrain/dev/audit"
    assert call["logEvents"][0]["message"]  # the serialized row
    # No sequence token on the first put; the cached token rides the second.
    assert "sequenceToken" not in call
    sink.emit(ROW)
    assert client.put_calls[1]["sequenceToken"] == "tok-1"


def test_disabled_is_noop():
    client = FakeLogsClient()
    sink = CloudWatchAuditSink(_settings(audit_cloudwatch_enabled=False), client=client)
    sink.emit(ROW)
    assert client.put_calls == []
    assert client.create_calls == []


def test_empty_log_group_is_noop():
    client = FakeLogsClient()
    sink = CloudWatchAuditSink(_settings(audit_cloudwatch_log_group=""), client=client)
    sink.emit(ROW)
    assert client.put_calls == []


def test_client_error_emits_marker_and_does_not_raise(caplog):
    client = FakeLogsClient(put_raises=RuntimeError("throttled"))
    sink = CloudWatchAuditSink(_settings(), client=client)
    with caplog.at_level(logging.ERROR):
        sink.emit(ROW)  # must not raise
    assert "audit_write_failed" in caplog.text
    assert "action=chat" in caplog.text
    # ids/hashes only - no raw request/response text in the marker.
    assert "b" * 64 not in caplog.text


def test_create_stream_already_exists_is_swallowed():
    class AlreadyExists(Exception):
        pass

    AlreadyExists.__name__ = "ResourceAlreadyExistsException"

    class C(FakeLogsClient):
        def create_log_stream(self, **kwargs):
            self.create_calls.append(kwargs)
            raise AlreadyExists()

    client = C()
    sink = CloudWatchAuditSink(_settings(), client=client)
    sink.emit(ROW)
    assert len(client.put_calls) == 1  # still wrote despite the create race


def test_invalid_sequence_token_retries_once():
    class InvalidSeq(Exception):
        def __init__(self):
            self.response = {"expectedSequenceToken": "good-token"}

    InvalidSeq.__name__ = "InvalidSequenceTokenException"

    calls = []

    class C(FakeLogsClient):
        def put_log_events(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise InvalidSeq()
            return {"nextSequenceToken": "tok-2"}

    client = C()
    sink = CloudWatchAuditSink(_settings(), client=client)
    # Prime a stale token so the first put carries the wrong one.
    sink._sequence_token = "stale"
    sink.emit(ROW)
    assert len(calls) == 2
    assert calls[1]["sequenceToken"] == "good-token"


def test_module_emit_audit_row_noop_when_disabled():
    reset_audit_sink_cache()
    try:
        # Default settings have the flag off; emit must be a harmless no-op.
        emit_audit_row(ROW)  # no exception, no boto3 needed
    finally:
        reset_audit_sink_cache()


def test_note_audit_write_failed_marker(caplog):
    with caplog.at_level(logging.ERROR):
        note_audit_write_failed(
            reason="durable_append_failed", tenant_id="t1", user_id="u1", action="chat"
        )
    assert "audit_write_failed" in caplog.text
    assert "reason=durable_append_failed" in caplog.text


def test_region_falls_back_to_sovereign_region():
    sink = CloudWatchAuditSink(
        _settings(audit_cloudwatch_region="", sovereign_region="eu-west-1")
    )
    assert sink._region == "eu-west-1"
