"""Slice 4: glossary candidate extraction from per-tenant memories."""
from __future__ import annotations

import pytest

from app.core.glossary_extractor import extract_candidates


def _mem(id_: str, body: str) -> dict:
    return {"id": id_, "body": body, "kind": "preference"}


def test_acronym_appearing_twice_is_a_candidate():
    cands = extract_candidates([
        _mem("m1", "We call wellhead pressure WHP on this asset."),
        _mem("m2", "WHP is reported in psi unless noted."),
    ])
    terms = [c.term for c in cands]
    assert "WHP" in terms
    by_term = {c.term: c for c in cands}
    assert by_term["WHP"].count == 2
    assert set(by_term["WHP"].memory_ids) == {"m1", "m2"}


def test_quoted_phrase_appearing_twice_is_a_candidate():
    cands = extract_candidates([
        _mem("m1", "We call wellhead pressure 'WHP' on the rig."),
        _mem("m2", "Field staff use 'WHP' in their day reports."),
    ])
    terms = [c.term for c in cands]
    assert "WHP" in terms


def test_single_occurrence_does_not_meet_min_count():
    cands = extract_candidates([
        _mem("m1", "We call wellhead pressure WHP on this asset."),
    ])
    assert cands == []


def test_already_promoted_terms_are_excluded():
    """The route passes already-promoted terminology bodies as
    ``exclude_terms`` so the candidate list doesn't loop on itself."""
    cands = extract_candidates(
        [
            _mem("m1", "WHP reported in psi."),
            _mem("m2", "When WHP exceeds 1200 psi, escalate."),
        ],
        exclude_terms=["WHP"],
    )
    assert cands == []


def test_same_term_twice_in_one_memory_counts_once():
    """A memory that mentions a term twice still only counts as one source -
    we want recurrence across memories, not within."""
    cands = extract_candidates([
        _mem("m1", "WHP and WHP again."),
        _mem("m2", "WHP elsewhere."),
    ])
    by_term = {c.term: c for c in cands}
    assert by_term["WHP"].count == 2
    assert set(by_term["WHP"].memory_ids) == {"m1", "m2"}


def test_common_stop_acronyms_are_filtered():
    """English pronouns / prepositions look like acronyms but aren't
    operator terminology. Conservative rejection."""
    cands = extract_candidates([
        _mem("m1", "It is on the rig."),
        _mem("m2", "It is on the same rig."),
    ])
    # 'IT', 'IS', 'ON', 'TO' etc. would all match the acronym regex but
    # should be filtered out. (These bodies are lowercase so they don't even
    # match - the test is here in case future heuristics start uppercasing.)
    terms = [c.term for c in cands]
    for stop in ("IT", "IS", "ON", "TO"):
        assert stop not in terms


def test_results_are_sorted_by_count_then_term():
    cands = extract_candidates([
        _mem("m1", "MAASP and WHP."),
        _mem("m2", "MAASP and WHP."),
        _mem("m3", "MAASP only."),
    ])
    # MAASP=3, WHP=2; MAASP must come first.
    assert [c.term for c in cands] == ["MAASP", "WHP"]


def test_acronym_with_digits_and_hyphen_is_captured():
    """Operator asset codes like ASSET-A or BONO-1 are common terminology."""
    cands = extract_candidates([
        _mem("m1", "Default unit on BONO-1 is metric."),
        _mem("m2", "On BONO-1 the kick SOP is rev B."),
    ])
    terms = [c.term for c in cands]
    assert "BONO-1" in terms


def test_malformed_memory_rows_are_skipped():
    """A memory without id or body should be ignored, not crash."""
    cands = extract_candidates([
        _mem("m1", "WHP twice on this asset."),
        {"id": None, "body": "WHP no id"},  # type: ignore[dict-item]
        {"id": "m3", "body": None},          # type: ignore[dict-item]
        _mem("m4", "WHP also."),
    ])
    by_term = {c.term: c for c in cands}
    # Both valid mentions counted, malformed rows ignored.
    assert by_term["WHP"].count == 2


def test_exclude_terms_are_case_insensitive():
    cands = extract_candidates(
        [
            _mem("m1", "WHP twice."),
            _mem("m2", "WHP also."),
        ],
        exclude_terms=["whp"],
    )
    assert cands == []
