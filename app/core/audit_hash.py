"""
Canonical-JSON SHA-256 hashing for the audit log (A6).

Raw user text and raw model output MUST NOT land in the audit store; we
record only the fingerprints. ``sha256_canonical`` produces a stable hex
digest for any JSON-serializable value: dicts are sorted by key, dates and
datetimes are isoformatted, and dataclasses fall through to their dict
representation - the same encoding scheme used in ghgemp_template.py.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from typing import Any


def sha256_canonical(value: Any) -> str:
    blob = json.dumps(value, default=_json_default, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if hasattr(value, "model_dump"):           # pydantic v2 BaseModel
        return value.model_dump(mode="json")
    if hasattr(value, "as_dict"):
        return value.as_dict()
    return str(value)
