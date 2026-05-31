import type { Module } from '@petrobrain/types';

export interface StreamChatAttachment {
  name: string;
  kind: 'image' | 'text' | 'document';
  mime_type: string;
  /** base64 (no data-URL prefix) for images; raw UTF-8 for text. */
  data: string | null;
}

export interface StreamChatRequest {
  message: string;
  module: Module;
  asset_context?: string | null;
  user_role?: string | null;
  jurisdiction?: string | null;
  offline_mode?: boolean;
  attachments?: StreamChatAttachment[];
}

export type StreamEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool_call'; data: { tool: string; id?: string; input: unknown } }
  | { event: 'tool_result'; data: { tool: string; result: Record<string, unknown> } }
  | { event: 'citation'; data: { title: string | null; revision: string | null; clause: string | null } }
  | { event: 'flag'; data: { flag: string } }
  | { event: 'done'; data: { answer: string; tool_results: unknown[]; flags: string[]; audit: Record<string, unknown> } };

export interface StreamChatOptions {
  baseUrl: string;
  token: string;
  body: StreamChatRequest;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

/**
 * POST /chat?stream=true and dispatch each SSE event to ``onEvent``.
 *
 * Matches the framing emitted by ``app/api/routes_chat.py::_sse``:
 *
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * Multiple events may arrive in a single chunk; the parser holds a
 * buffer and only flushes a complete record (blank line terminator).
 */
export async function streamChat({ baseUrl, token, body, signal, onEvent }: StreamChatOptions): Promise<void> {
  const url = new URL('/chat', baseUrl);
  url.searchParams.set('stream', 'true');
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const resp = await fetch(url.toString(), init);
  if (!resp.ok || !resp.body) {
    const detail = await safeText(resp);
    throw new Error(`chat stream failed (${resp.status}): ${detail}`);
  }
  await consumeSse(resp.body, onEvent);
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split on the SSE record terminator (blank line). Keep the trailing
    // partial record in the buffer for the next chunk.
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const record = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseRecord(record);
      if (parsed) onEvent(parsed);
      sep = buffer.indexOf('\n\n');
    }
  }
  // Flush a final record without trailing blank line (rare but legal).
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseRecord(tail);
    if (parsed) onEvent(parsed);
  }
}

function parseRecord(record: string): StreamEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of record.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (!event || dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  // Trust the backend; the union narrows on shape.
  return { event, data } as StreamEvent;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}
