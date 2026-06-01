/**
 * Conversation-share API client. Backend lives at /chat/shares (see
 * app/api/routes_chat_shares.py). Snapshots are minted client-side and
 * read back through the same tenant gate.
 */
import type { Conversation } from './conversations';

export interface ShareRecord {
  token: string;
  title: string;
  created_by: string;
  created_utc: string;
  expires_utc: string;
  revoked_utc: string | null;
  snapshot?: ConversationSnapshot;
}

export interface ConversationSnapshot {
  /** Frozen at mint time. Mirror of Conversation, minus ownerKey + project. */
  schema: 'pb-conversation-snapshot-v1';
  title: string;
  module: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  messages: Conversation['messages'];
}

export class ShareApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ShareApiError';
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function buildSnapshot(conv: Conversation, module: string): ConversationSnapshot {
  return {
    schema: 'pb-conversation-snapshot-v1',
    title: conv.title,
    module,
    conversationId: conv.id,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: conv.messages,
  };
}

export async function mintShare(
  baseUrl: string,
  token: string,
  body: { title: string; snapshot: ConversationSnapshot },
): Promise<ShareRecord> {
  const res = await fetch(`${baseUrl}/chat/shares`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await asError(res);
  return (await res.json()) as ShareRecord;
}

export async function fetchShare(
  baseUrl: string,
  token: string,
  shareToken: string,
): Promise<ShareRecord> {
  const res = await fetch(`${baseUrl}/chat/shares/${encodeURIComponent(shareToken)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) throw await asError(res);
  return (await res.json()) as ShareRecord;
}

export async function revokeShare(
  baseUrl: string,
  token: string,
  shareToken: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/chat/shares/${encodeURIComponent(shareToken)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) throw await asError(res);
}

export async function listMyShares(baseUrl: string, token: string): Promise<ShareRecord[]> {
  const res = await fetch(`${baseUrl}/chat/shares`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) throw await asError(res);
  const body = (await res.json()) as { shares: ShareRecord[] };
  return body.shares;
}

async function asError(res: Response): Promise<ShareApiError> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { detail?: string };
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // Body wasn't JSON; keep the status line.
  }
  return new ShareApiError(detail, res.status);
}

export function shareUrlFor(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/share/${encodeURIComponent(token)}`;
}
