import type { Citation } from '@petrobrain/types';

import { listChunksForDocuments, listDocuments } from '../cache/database.js';
import { searchCache } from '../cache/search.js';
import type { CachedDocument } from '../cache/types.js';

export interface AskAnswer {
  text: string;
  citations: Citation[];
  source: 'online' | 'offline_cache' | 'no_match';
}

export interface OnlineAskOpts {
  baseUrl: string;
  token: string;
  module: 'general' | 'well_control' | 'emissions_mrv';
  asset_context: string | null;
  user_role?: string;
}

/**
 * One-shot ``POST /chat`` for the field app's Ask tab.
 *
 * The web app uses SSE streaming; the field app keeps the round trip
 * blocking so the answer + citations + flags all arrive in one frame
 * (TTS reads the whole answer in one go, so streaming gives no win
 * here). Errors raise so the caller can fall back to ``askOffline``.
 */
export async function askOnline(query: string, opts: OnlineAskOpts): Promise<AskAnswer> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({
      message: query,
      module: opts.module,
      asset_context: opts.asset_context,
      user_role: opts.user_role ?? null,
      offline_mode: false,
    }),
  };
  const resp = await fetch(new URL('/chat', opts.baseUrl).toString(), init);
  if (!resp.ok) {
    throw new Error(`/chat returned ${resp.status}`);
  }
  const body = (await resp.json()) as {
    answer: string;
    tool_results?: unknown[];
    flags?: string[];
    citations?: unknown[];
  };
  return {
    text: body.answer,
    citations: extractCitations(body),
    source: 'online',
  };
}

/**
 * Offline Ask path - search the local SQLite cache and synthesise a short
 * answer from the top hit. The "answer" is the chunk text itself
 * preceded by the document title + clause, so the user always sees
 * provenance and the TTS reads the source verbatim.
 *
 * Never invents content. If nothing matches, returns ``no_match`` so the
 * caller can show "I don't have that offline" instead of a hallucination.
 */
export async function askOffline(
  query: string,
  tenantId: string,
): Promise<AskAnswer> {
  const documents = await listDocuments(tenantId);
  if (documents.length === 0) return noMatch();
  const chunks = await listChunksForDocuments(documents.map((d) => d.document_id));
  const hits = searchCache(query, documents, chunks, { limit: 3 });
  if (hits.length === 0) return noMatch();
  const top = hits[0]!;
  const otherCitations = hits.slice(1).map((h) => toCitation(h.document, h.chunk.clause));
  return {
    text: `${top.document.title}${top.chunk.clause ? ` · ${top.chunk.clause}` : ''}\n\n${top.chunk.text}`,
    citations: [toCitation(top.document, top.chunk.clause), ...otherCitations],
    source: 'offline_cache',
  };
}

function noMatch(): AskAnswer {
  return {
    text: "I don't have anything matching that question in the offline cache. Try again when online - the chat surface has retrieval over your tenant's full SOP set.",
    citations: [],
    source: 'no_match',
  };
}

function toCitation(doc: CachedDocument, clause: string | null): Citation {
  return {
    title: doc.title,
    revision: doc.revision || null,
    clause,
  };
}

function extractCitations(body: { citations?: unknown[]; [k: string]: unknown }): Citation[] {
  // ``POST /chat`` now returns retrieved citations in the non-streaming body
  // (same {title, revision, clause} shape the SSE ``citation`` events use).
  // Map defensively and never fabricate: unknown shapes drop to null fields.
  const raw = Array.isArray(body.citations) ? body.citations : [];
  return raw.map((c): Citation => {
    const o = (c ?? {}) as { title?: unknown; revision?: unknown; clause?: unknown };
    return {
      title: typeof o.title === 'string' ? o.title : '',
      revision: typeof o.revision === 'string' ? o.revision : null,
      clause: typeof o.clause === 'string' ? o.clause : null,
    };
  });
}
