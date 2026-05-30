'use client';

import { useCallback, useRef, useState } from 'react';

import type { Citation, ToolResult } from '@petrobrain/types';

import { useChatStore } from '@/lib/chat/store';
import { streamChat, type StreamEvent } from '@/lib/chat/streamChat';

import { AuthGate } from './components/AuthGate';
import { ChatComposer } from './components/ChatComposer';
import { ChatSidebar } from './components/ChatSidebar';
import { EmptyState } from './components/EmptyState';
import { MessageList } from './components/MessageList';
import type { AssistantMessage, Message } from '@/lib/chat/types';

let messageCounter = 0;
function nextId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}-${Date.now()}-${messageCounter}`;
}

export function ChatClient() {
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const module = useChatStore((s) => s.module);
  const assetContext = useChatStore((s) => s.assetContext);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);

  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string) => {
      if (!token || !principal || !text.trim() || sending) return;

      const userMsg: Message = {
        id: nextId('u'),
        role: 'user',
        text,
        module,
        assetContext,
        createdAt: Date.now(),
      };
      const assistantId = nextId('a');
      const assistantMsg: AssistantMessage = {
        id: assistantId,
        role: 'assistant',
        text: '',
        citations: [],
        toolResults: [],
        flags: [],
        streaming: true,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setError(null);
      setSending(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat({
          baseUrl: apiBaseUrl,
          token,
          body: {
            message: text,
            module,
            asset_context: assetContext,
            user_role: principal.role,
          },
          signal: controller.signal,
          onEvent: (event) => {
            setMessages((prev) => applyEvent(prev, assistantId, event));
          },
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        setError(detail);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && m.role === 'assistant'
              ? { ...m, streaming: false, error: detail }
              : m,
          ),
        );
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [apiBaseUrl, assetContext, module, principal, sending, token],
  );

  if (!token || !principal) {
    return <AuthGate />;
  }

  return (
    <div className="grid min-h-screen grid-cols-[18rem_minmax(0,1fr)] gap-0">
      <ChatSidebar />
      <section className="flex h-screen flex-col bg-white">
        <header className="border-b border-neutral-200 px-6 py-4">
          <h1 className="text-lg font-semibold text-neutral-800">Chat</h1>
          <p className="text-xs text-neutral-500">
            Decision support. Verify safety-critical numbers with the competent person before acting.
          </p>
        </header>
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState onPrompt={send} />
          ) : (
            <MessageList messages={messages} />
          )}
        </div>
        {error ? (
          <div className="border-t border-danger-border bg-danger-bg px-6 py-2 text-sm text-danger-fg">
            {error}
          </div>
        ) : null}
        <ChatComposer onSubmit={send} disabled={sending || !token} />
      </section>
    </div>
  );
}

/**
 * Reducer-style update applied for every SSE event. Pure (no I/O) so the
 * Message renderer test can drive it directly without hitting the network.
 */
export function applyEvent(
  messages: Message[],
  assistantId: string,
  event: StreamEvent,
): Message[] {
  return messages.map((m) => {
    if (m.id !== assistantId || m.role !== 'assistant') return m;
    switch (event.event) {
      case 'token':
        return { ...m, text: m.text + event.data.text };
      case 'citation':
        return { ...m, citations: [...m.citations, event.data as Citation] };
      case 'tool_call':
        // Record the call slot now so the result event can fill it.
        return {
          ...m,
          toolResults: [
            ...m.toolResults,
            { tool: event.data.tool, input: event.data.input, result: null as unknown },
          ],
        };
      case 'tool_result':
        return {
          ...m,
          toolResults: mergeToolResult(m.toolResults, event.data),
        };
      case 'flag':
        return m.flags.includes(event.data.flag)
          ? m
          : { ...m, flags: [...m.flags, event.data.flag] };
      case 'done':
        return {
          ...m,
          // Backend ``done`` carries the final reconciled answer + tool_results.
          // Prefer it over our incremental token buffer to handle the case
          // where the assistant prepended a live-event banner inside the orch.
          text: event.data.answer || m.text,
          toolResults: (event.data.tool_results as ToolResult[]) ?? m.toolResults,
          flags: event.data.flags ?? m.flags,
          streaming: false,
        };
      default:
        return m;
    }
  });
}

function mergeToolResult(
  results: ToolResult[],
  event: { tool: string; result: Record<string, unknown> },
): ToolResult[] {
  const idx = results.findIndex((r) => r.tool === event.tool && r.result === null);
  if (idx === -1) {
    return [...results, { tool: event.tool, input: undefined, result: event.result }];
  }
  const next = results.slice();
  const existing = next[idx]!;
  next[idx] = { tool: existing.tool, input: existing.input, result: event.result };
  return next;
}
