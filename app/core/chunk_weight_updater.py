"""Apply user feedback to per-tenant chunk weights (slice 3 policy layer).

The repository in app.db.chunk_weights_repository is pure data: it stores and
clamps. The policy lives here so the step sizes, the asymmetry, and the
safety floor are all in one auditable place.

Policy (defaults in app.config; per-tenant override is a Phase-2 follow-up):
  * 👍 multiplies each cited chunk's weight by ``chunk_weight_up_step``
    (default 1.05), capped at ``chunk_weight_ceiling`` (default 1.5).
  * 👎 multiplies each cited chunk's weight by ``chunk_weight_down_step``
    (default 0.90), floored at ``chunk_weight_floor`` (default 0.5).
  * The floor is the load-bearing safety guarantee: heavy negative feedback
    can demote a chunk by 50% but cannot remove it from retrieval. A safety
    SOP that the operator finds annoying cannot be feedbacked out of
    existence.
  * Asymmetric: bad answers earn faster penalty than good answers earn boost
    so the system corrects from a single bad citation more aggressively than
    it celebrates a single good one.

Failure-safe: any error during weight update is swallowed (logged at warning
level). The learning loop is best-effort - the user's thumbs already landed
in feedback_events, so the audit trail is complete even if the weight nudge
fails.
"""
from __future__ import annotations

import logging

from app.config import get_settings

logger = logging.getLogger(__name__)


def update_weights_from_feedback(
    *, tenant_id: str, turn_id: str, rating: str,
) -> int:
    """Look up the chunks attributed to this turn, apply the per-rating
    multiplier to each, and return the count of chunks updated. Returns 0 on
    any failure (no attribution, repo error, unknown rating)."""
    if rating not in {"up", "down"}:
        return 0
    if not tenant_id or not turn_id:
        return 0
    try:
        from app.core.turn_attribution import recall_turn_chunks

        chunk_ids = recall_turn_chunks(tenant_id=tenant_id, turn_id=turn_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("attrib_recall_failed", extra={"error": str(exc)})
        return 0
    if not chunk_ids:
        return 0

    settings = get_settings()
    multiplier = (
        settings.chunk_weight_up_step if rating == "up"
        else settings.chunk_weight_down_step
    )

    try:
        from app.db.chunk_weights_repository import get_chunk_weights_repository

        repo = get_chunk_weights_repository()
    except Exception as exc:  # noqa: BLE001
        logger.warning("chunk_weights_repo_unavailable", extra={"error": str(exc)})
        return 0

    updated = 0
    for chunk_id in chunk_ids:
        try:
            repo.bump(
                tenant_id=tenant_id, chunk_id=int(chunk_id),
                multiplier=multiplier, rating=rating,
            )
            updated += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "chunk_weight_bump_failed",
                extra={"chunk_id": chunk_id, "error": str(exc)},
            )
    return updated
