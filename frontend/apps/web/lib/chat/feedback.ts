/**
 * POST /chat/feedback - record a per-turn thumbs-up / thumbs-down and
 * optional reason. Idempotent on the server (one row per turn per user), so
 * re-clicking just overwrites. Optimistic UI lives in the component; this
 * helper only handles the wire call + error normalization.
 */
import type { FeedbackRating } from './types.js';

export interface SubmitFeedbackArgs {
  baseUrl: string;
  token: string;
  turnId: string;
  rating: FeedbackRating;
  reason?: string | null;
  module?: string | null;
  signal?: AbortSignal;
}

export interface SubmittedFeedback {
  id: string;
  turnId: string;
  rating: FeedbackRating;
  reason: string | null;
  createdUtc: string;
}

export class FeedbackError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'FeedbackError';
  }
}

export async function submitFeedback(args: SubmitFeedbackArgs): Promise<SubmittedFeedback> {
  const res = await fetch(`${args.baseUrl}/chat/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      turn_id: args.turnId,
      rating: args.rating,
      reason: args.reason ?? null,
      module: args.module ?? null,
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      // fall through with status-line text
    }
    throw new FeedbackError(detail, res.status);
  }
  const body = (await res.json()) as {
    id: string;
    turn_id: string;
    rating: FeedbackRating;
    reason: string | null;
    created_utc: string;
  };
  return {
    id: body.id,
    turnId: body.turn_id,
    rating: body.rating,
    reason: body.reason,
    createdUtc: body.created_utc,
  };
}
