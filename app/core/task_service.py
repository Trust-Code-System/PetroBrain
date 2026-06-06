"""Deterministic parsing and scheduling for PetroBrain task requests."""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


TASK_INTENT = re.compile(
    r"\b(?:remind|reminder|schedule|recurring|task|assign|follow[- ]?up|"
    r"compliance calendar|digest)\b",
    re.I,
)

AUDIT_INTENT = re.compile(
    r"\b(?:audit trail|audit log|admin log|safety flags|bypass attempts?|"
    r"who asked|sources used|tool calls|compliance evidence)\b",
    re.I,
)


@dataclass(frozen=True)
class ParsedTask:
    create: bool
    missing: list[str]
    data: dict[str, Any]


def is_task_request(text: str) -> bool:
    return bool(TASK_INTENT.search(text or ""))


def is_audit_request(text: str) -> bool:
    return bool(AUDIT_INTENT.search(text or ""))


def parse_task_request(
    text: str,
    *,
    timezone_name: str = "Africa/Lagos",
    now: datetime | None = None,
) -> ParsedTask:
    raw = " ".join((text or "").split())
    lowered = raw.lower()
    tz = _timezone(timezone_name)
    local_now = (now or datetime.now(timezone.utc)).astimezone(tz)
    recurrence_type, recurrence_rule = _recurrence(lowered)
    due = _next_run(lowered, recurrence_type, recurrence_rule, local_now)
    team = _team(lowered)
    category, module, compliance = _category(lowered)
    digest = "digest" in lowered
    if digest and team is None:
        team = "Research"
    if digest:
        category, module, compliance = "scheduled_research_digest", "research", False

    missing: list[str] = []
    if not team and not re.search(r"\b(?:myself|me)\b", lowered):
        missing.append("assignee or team")
    if recurrence_type == "none" and due is None:
        missing.append("date or recurrence")
    if "permit expiry" in lowered and not re.search(r"\b\d{4}-\d{2}-\d{2}\b", lowered):
        missing.append("permit expiry date")

    title = _title(raw, category)
    data: dict[str, Any] = {
        "title": title,
        "description": raw,
        "category": category,
        "priority": "critical" if "critical" in lowered else "high" if compliance else "medium",
        "assigned_to_team": team,
        "assigned_to_user_ids": [],
        "recurrence_type": recurrence_type,
        "recurrence_rule": recurrence_rule,
        "start_date": due,
        "due_date": due if recurrence_type == "none" else None,
        "next_run_at": due,
        "timezone": timezone_name,
        "reminder_channels": ["in_app"],
        "related_module": module,
        "safety_critical": category in {"ptw_expiry", "hse_audit", "incident_follow_up"},
        "compliance_critical": compliance,
    }
    if digest:
        data["digest_config"] = {
            "topics": _digest_topics(raw),
            "sources_allowed": ["official", "regulator", "company", "industry"],
            "domains_allowed": [],
            "output_format": "research_draft",
            "read_only": True,
            "citations_required": True,
            "external_actions_enabled": False,
        }
    return ParsedTask(create=not missing, missing=missing, data=data)


def advance_next_run(task: dict[str, Any], *, from_time: datetime | None = None) -> str | None:
    recurrence = task.get("recurrence_type") or "none"
    if recurrence == "none":
        return None
    tz = _timezone(task.get("timezone") or "Africa/Lagos")
    base_raw = task.get("next_run_at")
    if isinstance(base_raw, str):
        base = datetime.fromisoformat(base_raw.replace("Z", "+00:00")).astimezone(tz)
    else:
        base = (from_time or datetime.now(timezone.utc)).astimezone(tz)
    if recurrence == "daily":
        value = base + timedelta(days=1)
    elif recurrence == "weekly":
        value = base + timedelta(weeks=1)
    elif recurrence == "monthly":
        value = _add_months(base, 1)
    elif recurrence == "quarterly":
        value = _add_months(base, 3)
    elif recurrence == "yearly":
        value = _add_months(base, 12)
    else:
        days = int((task.get("recurrence_rule") or {}).get("interval_days") or 1)
        value = base + timedelta(days=days)
    return value.astimezone(timezone.utc).isoformat()


def _recurrence(text: str) -> tuple[str, dict[str, Any]]:
    weekdays = {
        "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
        "friday": 4, "saturday": 5, "sunday": 6,
    }
    for label, index in weekdays.items():
        if re.search(rf"\b(?:every|weekly|each)\s+{label}\b", text):
            return "weekly", {"weekday": index, "weekday_label": label.title(), "hour": _hour(text)}
    if re.search(r"\b(?:every day|daily)\b", text):
        return "daily", {"hour": _hour(text)}
    if re.search(r"\b(?:every week|weekly)\b", text):
        return "weekly", {"weekday": 0, "weekday_label": "Monday", "hour": _hour(text)}
    if re.search(r"\b(?:every month|monthly)\b", text):
        return "monthly", {"day_of_month": None, "hour": _hour(text)}
    if re.search(r"\b(?:every quarter|quarterly)\b", text):
        return "quarterly", {"hour": _hour(text)}
    if re.search(r"\b(?:every year|yearly|annually)\b", text):
        return "yearly", {"hour": _hour(text)}
    return "none", {}


def _next_run(
    text: str,
    recurrence: str,
    rule: dict[str, Any],
    now: datetime,
) -> datetime | None:
    iso_match = re.search(r"\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):?(\d{2})?)?\b", text)
    if iso_match:
        hour = int(iso_match.group(2) or _hour(text))
        minute = int(iso_match.group(3) or 0)
        return datetime.fromisoformat(iso_match.group(1)).replace(
            hour=hour, minute=minute, tzinfo=now.tzinfo
        ).astimezone(timezone.utc)
    hour = int(rule.get("hour") or _hour(text))
    candidate = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if "next week" in text:
        return (candidate + timedelta(weeks=1)).astimezone(timezone.utc)
    if "tomorrow" in text:
        return (candidate + timedelta(days=1)).astimezone(timezone.utc)
    if recurrence == "daily":
        if candidate <= now:
            candidate += timedelta(days=1)
    elif recurrence == "weekly":
        target = int(rule.get("weekday", 0))
        days = (target - now.weekday()) % 7
        if days == 0 and candidate <= now:
            days = 7
        candidate += timedelta(days=days)
    elif recurrence == "monthly":
        candidate = _add_months(candidate, 1)
    elif recurrence == "quarterly":
        candidate = _add_months(candidate, 3)
    elif recurrence == "yearly":
        candidate = _add_months(candidate, 12)
    else:
        return None
    return candidate.astimezone(timezone.utc)


def _hour(text: str) -> int:
    match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", text)
    if match:
        hour = int(match.group(1)) % 12
        if match.group(3) == "pm":
            hour += 12
        return hour
    if "morning" in text:
        return 9
    if "afternoon" in text:
        return 14
    return 9


def _team(text: str) -> str | None:
    aliases = (
        ("emissions team", "Emissions"),
        ("compliance team", "Compliance"),
        ("hse", "HSE"),
        ("maintenance", "Maintenance"),
        ("production team", "Production"),
        ("management", "Management"),
        ("board", "Board Secretariat"),
        ("research team", "Research"),
    )
    return next((label for phrase, label in aliases if phrase in text), None)


def _category(text: str) -> tuple[str, str, bool]:
    choices = (
        ("ghg inventory", "ghg_inventory_preparation", "emissions_mrv", True),
        ("nuprc", "nuprc_reporting", "research", True),
        ("ogmp", "ogmp_reporting", "emissions_mrv", True),
        ("ldar", "ldar_inspection", "emissions_mrv", True),
        ("flare", "flare_monitoring", "emissions_mrv", True),
        ("ptw", "ptw_expiry", "ptw", True),
        ("permit", "permit_renewal", "ptw", True),
        ("training", "hse_training_renewal", "general", True),
        ("incident", "incident_follow_up", "general", True),
        ("audit action", "audit_action_follow_up", "general", True),
        ("production report", "weekly_production_report", "general", False),
        ("board report", "board_report_preparation", "general", False),
        ("management report", "monthly_management_report", "general", False),
        ("digest", "weekly_regulatory_update_digest", "research", False),
        ("emissions", "emissions_reporting", "emissions_mrv", True),
    )
    for phrase, category, module, critical in choices:
        if phrase in text:
            return category, module, critical
    return "compliance_calendar", "general", True


def _title(raw: str, category: str) -> str:
    cleaned = re.sub(
        r"^(?:please\s+)?(?:create|schedule|add|set up|remind)\s+(?:a\s+)?",
        "",
        raw,
        flags=re.I,
    ).strip(" .")
    if len(cleaned) > 120:
        cleaned = cleaned[:117].rstrip() + "..."
    return cleaned or category.replace("_", " ").title()


def _digest_topics(text: str) -> list[str]:
    tail = re.split(r"\b(?:on|about|covering)\b", text, maxsplit=1, flags=re.I)
    source = tail[-1]
    return [
        part.strip(" .")
        for part in re.split(r",|\band\b", source, flags=re.I)
        if part.strip(" .")
    ][:12]


def _add_months(value: datetime, months: int) -> datetime:
    total = value.year * 12 + value.month - 1 + months
    year, month_index = divmod(total, 12)
    month = month_index + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def _timezone(name: str):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return timezone.utc
