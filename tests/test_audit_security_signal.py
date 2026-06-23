"""The durable audit store emits an out-of-band stdout marker for security events."""
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db.audit_events_repository import LocalJsonAuditEventsRepository


def _append(repo, *, action, flags=None):
    return repo.append(
        tenant_id="t1", user_id="u1", role="engineer", action=action,
        module="well_control", request_hash="a" * 64, response_hash="",
        flags=flags or [],
    )


def test_bypass_attempt_emits_security_marker(tmp_path, caplog):
    repo = LocalJsonAuditEventsRepository(tmp_path / "audit.jsonl")
    with caplog.at_level(logging.WARNING):
        _append(repo, action="bypass_attempt", flags=["safety_bypass", "kill_system"])
    assert "audit_security_event" in caplog.text
    assert "action=bypass_attempt" in caplog.text
    # No raw payload leaks into the marker.
    assert "kill_system" in caplog.text  # rule name (a flag) is fine; it's not user text


def test_safety_bypass_flag_alone_triggers_marker(tmp_path, caplog):
    repo = LocalJsonAuditEventsRepository(tmp_path / "audit.jsonl")
    with caplog.at_level(logging.WARNING):
        _append(repo, action="chat", flags=["safety_bypass"])
    assert "audit_security_event" in caplog.text


def test_ordinary_event_emits_no_marker(tmp_path, caplog):
    repo = LocalJsonAuditEventsRepository(tmp_path / "audit.jsonl")
    with caplog.at_level(logging.WARNING):
        _append(repo, action="chat", flags=[])
    assert "audit_security_event" not in caplog.text
