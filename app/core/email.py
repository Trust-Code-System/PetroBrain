"""Transactional email delivery via Resend (https://resend.com).

Kept deliberately small: a single synchronous httpx call to the Resend REST
API. Sending never raises into the request path - every helper returns a
``delivery`` dict (``email_sent`` + human ``message``) so the caller can report
the real outcome while still returning the created invitation.
"""
from __future__ import annotations

import html
import logging
from datetime import datetime
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

RESEND_ENDPOINT = "https://api.resend.com/emails"
_TIMEOUT_SECONDS = 10.0


def email_delivery_active() -> bool:
    """True when outbound invitation email is configured (a Resend key is set)."""
    return bool(get_settings().resend_api_key.strip())


def _format_expiry(expires_at: Any) -> str:
    if isinstance(expires_at, datetime):
        return expires_at.strftime("%d %b %Y")
    text = str(expires_at or "").strip()
    if not text:
        return ""
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).strftime("%d %b %Y")
    except ValueError:
        return text


def _invite_url(raw_token: str) -> str:
    base = get_settings().app_public_base_url.rstrip("/")
    return f"{base}/invitations/{raw_token}"


def _render_invite_html(
    *, company_name: str, role_label: str, invite_url: str, expires: str, message: str | None
) -> str:
    safe_company = html.escape(company_name)
    safe_role = html.escape(role_label)
    note = (
        f'<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:22px;">'
        f'"{html.escape(message)}"</p>'
        if message
        else ""
    )
    expiry_line = (
        f'<p style="margin:16px 0 0;color:#a1a1aa;font-size:12px;">This invitation expires {expires}.</p>'
        if expires
        else ""
    )
    return f"""\
<div style="background:#fafafa;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;padding:32px;">
    <p style="margin:0 0 8px;color:#ea580c;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">PetroBrain invitation</p>
    <h1 style="margin:0 0 16px;color:#18181b;font-size:22px;">You have been invited to join {safe_company}</h1>
    <p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:22px;">
      You were invited as <strong>{safe_role}</strong>. Accept the invitation to create your password and enter the workspace.
    </p>
    {note}
    <a href="{invite_url}" style="display:inline-block;background:#ea580c;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:12px;">Accept invitation</a>
    <p style="margin:20px 0 0;color:#a1a1aa;font-size:12px;line-height:18px;word-break:break-all;">
      Or paste this link into your browser:<br/>{invite_url}
    </p>
    {expiry_line}
  </div>
</div>"""


def send_invitation_email(
    *,
    to_email: str,
    company_name: str,
    role_label: str,
    raw_token: str,
    expires_at: Any = None,
    message: str | None = None,
) -> dict[str, Any]:
    """Send an invitation email through Resend.

    Returns a ``delivery`` dict; never raises. When no Resend key is configured
    the invite is still valid and the link is surfaced in the UI instead.
    """
    settings = get_settings()
    api_key = settings.resend_api_key.strip()
    if not api_key:
        return {
            "email_sent": False,
            "message": "Invite created inside PetroBrain. Email delivery is not enabled yet.",
        }

    invite_url = _invite_url(raw_token)
    payload = {
        "from": settings.invite_email_from,
        "to": [to_email],
        "subject": f"You have been invited to join {company_name} on PetroBrain",
        "html": _render_invite_html(
            company_name=company_name,
            role_label=role_label,
            invite_url=invite_url,
            expires=_format_expiry(expires_at),
            message=message,
        ),
    }
    try:
        response = httpx.post(
            RESEND_ENDPOINT,
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
            timeout=_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:200] if exc.response is not None else str(exc)
        logger.warning("resend invite email failed: %s", detail)
        return {
            "email_sent": False,
            "message": "Invite created, but the email could not be delivered. Share the secure link instead.",
        }
    except httpx.HTTPError as exc:
        logger.warning("resend invite email transport error: %s", exc)
        return {
            "email_sent": False,
            "message": "Invite created, but the email service was unreachable. Share the secure link instead.",
        }
    return {"email_sent": True, "message": f"Invitation email sent to {to_email}."}
