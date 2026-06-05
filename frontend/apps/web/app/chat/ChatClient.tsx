'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Citation, ToolResult } from '@petrobrain/types';

import { useChatStore } from '@/lib/chat/store';
import { ownerKeyOf, useConversationsStore } from '@/lib/chat/conversations';
import {
  exportAssistantMessageMarkdown,
  exportAssistantMessagePdf,
  exportAssistantMessageText,
  exportAssistantMessageWord,
  exportConversationPdf,
  isExportable,
} from '@/lib/chat/exportConversation';
import { buildSnapshot, mintShare, shareUrlFor, ShareApiError } from '@/lib/chat/shares';
import { isCanvasWorthy } from '@/lib/chat/canvas';
import { useProjectsStore } from '@/lib/chat/projects';
import { useSettingsStore } from '@/lib/chat/settings';
import { SessionExpiredError, streamChat, type StreamEvent } from '@/lib/chat/streamChat';
import { submitFeedback } from '@/lib/chat/feedback';
import { createTokenStreamer } from '@/lib/chat/tokenStreamer';
import { reportError } from '@/lib/errors/report';

import { AuthGate } from './components/AuthGate';
import { CanvasPanel } from './components/CanvasPanel';
import { ChatComposer } from './components/ChatComposer';
import { ChatSidebar } from './components/ChatSidebar';
import { EmptyState } from './components/EmptyState';
import { MessageList } from './components/MessageList';
import { ModulePill } from './components/ModulePill';
import type {
  AssistantMessage,
  FeedbackRating,
  Message,
  MessageAttachment,
} from '@/lib/chat/types';

let messageCounter = 0;
function nextId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}-${Date.now()}-${messageCounter}`;
}

const EMPTY_MESSAGES: Message[] = [];

type AnswerExportFormat = 'pdf' | 'word' | 'markdown' | 'text';

function detectAnswerExportRequest(text: string): AnswerExportFormat | null {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const asksForExport =
    /\b(convert|export|download|save|put|make|turn|create|give me|give|send)\b/.test(q)
    && /\b(this|that|answer|response|reply|it|the answer|the response)\b/.test(q)
    && /\b(pdf|word|docx|doc|document|markdown|md|text|txt)\b/.test(q);

  if (!asksForExport) return null;
  if (/\bpdf\b/.test(q)) return 'pdf';
  if (/\b(word|docx|doc)\b/.test(q)) return 'word';
  if (/\b(markdown|md)\b/.test(q)) return 'markdown';
  if (/\b(text|txt)\b/.test(q)) return 'text';
  if (/\bdocument\b/.test(q)) return 'word';
  return null;
}

function findLastExportableAssistantMessage(messages: Message[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && !msg.streaming && msg.text.trim().length > 0) {
      return msg;
    }
  }
  return null;
}

function exportAssistantAnswer(
  message: AssistantMessage,
  format: AnswerExportFormat,
  title: string,
): string {
  if (format === 'pdf') {
    exportAssistantMessagePdf(message, title);
    return 'I opened the PDF export view for the previous answer. Choose Save as PDF in the print dialog.';
  }
  if (format === 'word') {
    exportAssistantMessageWord(message, title);
    return 'I downloaded the previous answer as a Word-compatible document.';
  }
  if (format === 'markdown') {
    exportAssistantMessageMarkdown(message, title);
    return 'I downloaded the previous answer as a Markdown file.';
  }
  exportAssistantMessageText(message, title);
  return 'I downloaded the previous answer as a text file.';
}

export function ChatClient() {
  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const module = useChatStore((s) => s.module);
  const assetContext = useChatStore((s) => s.assetContext);
  const thinkingMode = useChatStore((s) => s.thinkingMode);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const hasHydrated = useChatStore((s) => s.hasHydrated);
  const webSearchEnabled = useChatStore((s) => s.webSearchEnabled);
  const forceCanvasNext = useChatStore((s) => s.forceCanvasNext);
  const setForceCanvasNext = useChatStore((s) => s.setForceCanvasNext);
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed);
  const expireSession = useChatStore((s) => s.expireSession);

  const ownerKey = useMemo(() => ownerKeyOf(principal), [principal]);

  const activeId = useConversationsStore((s) => s.activeId);
  const conversations = useConversationsStore((s) => s.conversations);
  const newConversation = useConversationsStore((s) => s.newConversation);
  const setMessagesInStore = useConversationsStore((s) => s.setMessages);
  const setTitleFromFirstMessage = useConversationsStore((s) => s.setTitleFromFirstMessage);

  const activeProjectId = useProjectsStore((s) => s.activeId);
  const projects = useProjectsStore((s) => s.projects);
  const selectProject = useProjectsStore((s) => s.selectProject);
  const customInstructions = useSettingsStore((s) => s.customInstructions);
  const defaultModule = useSettingsStore((s) => s.defaultModule);
  const enableNotifications = useSettingsStore((s) => s.enableNotifications);
  const settingsHydrated = useSettingsStore((s) => s.hasHydrated);
  const setModule = useChatStore((s) => s.setModule);

  // When settings finish hydrating and the user is on a fresh chat (no
  // conversation yet), apply their default module so the new chat starts
  // in the right context.
  useEffect(() => {
    if (!settingsHydrated || activeId) return;
    if (defaultModule && defaultModule !== module) {
      setModule(defaultModule);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsHydrated, activeId]);
  const activeProject = useMemo(() => {
    if (!activeProjectId || !ownerKey) return null;
    const p = projects[activeProjectId];
    return p && p.ownerKey === ownerKey ? p : null;
  }, [activeProjectId, projects, ownerKey]);

  // Resolve the active conversation, scoped to the signed-in principal so
  // someone else's chats on the same browser stay hidden.
  const activeConversation = useMemo(() => {
    if (!activeId || !ownerKey) return null;
    const convo = conversations[activeId];
    if (!convo || convo.ownerKey !== ownerKey) return null;
    return convo;
  }, [activeId, conversations, ownerKey]);

  const messages: Message[] = activeConversation?.messages ?? EMPTY_MESSAGES;

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [canvasMessageId, setCanvasMessageId] = useState<string | null>(null);
  const lastAutoOpenedRef = useRef<string | null>(null);

  const canvasMessage = useMemo(() => {
    if (!canvasMessageId) return null;
    const m = messages.find((msg) => msg.id === canvasMessageId);
    return m && m.role === 'assistant' ? m : null;
  }, [canvasMessageId, messages]);

  // Auto-open the canvas the first time an assistant turn settles AND is
  // canvas-worthy. We track which id we already auto-opened against so flipping
  // back to the conversation doesn't re-open it after a manual close.
  // forceCanvasNext is a one-shot composer-menu intent: open the next settled
  // assistant message regardless of length, then clear the flag.
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      if (m.streaming) return;
      if (forceCanvasNext && lastAutoOpenedRef.current !== m.id) {
        lastAutoOpenedRef.current = m.id;
        setCanvasMessageId(m.id);
        setForceCanvasNext(false);
        return;
      }
      if (canvasMessageId) return;
      if (lastAutoOpenedRef.current === m.id) return;
      if (isCanvasWorthy(m)) {
        lastAutoOpenedRef.current = m.id;
        setCanvasMessageId(m.id);
      }
      return;
    }
  }, [messages, canvasMessageId, forceCanvasNext, setForceCanvasNext]);

  // Reset auto-open memory when the user switches conversations so the
  // first canvas-worthy message in the new thread opens once.
  useEffect(() => {
    lastAutoOpenedRef.current = null;
    setCanvasMessageId(null);
  }, [activeId]);

  const closeCanvas = useCallback(() => setCanvasMessageId(null), []);
  const openCanvas = useCallback((messageId: string) => setCanvasMessageId(messageId), []);

  const [shareStatus, setShareStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'minting' }
    | { kind: 'shared'; url: string; expiresUtc: string; copied: boolean }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const closeShareModal = useCallback(() => setShareStatus({ kind: 'idle' }), []);

  const copyShareLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setShareStatus((current) =>
        current.kind === 'shared' ? { ...current, copied: true } : current,
      );
      window.setTimeout(() => {
        setShareStatus((current) =>
          current.kind === 'shared' ? { ...current, copied: false } : current,
        );
      }, 1600);
    } catch {
      setShareStatus((current) =>
        current.kind === 'shared' ? { ...current, copied: false } : current,
      );
    }
  }, []);

  const share = useCallback(async () => {
    if (!token || !activeConversation || !isExportable(messages)) return;
    setShareStatus({ kind: 'minting' });
    try {
      const snapshot = buildSnapshot(activeConversation, module);
      const record = await mintShare(apiBaseUrl, token, {
        title: activeConversation.title || 'Untitled conversation',
        snapshot,
      });
      const url = shareUrlFor(record.token, window.location.origin);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard may be blocked in non-secure contexts - still show the link.
      }
      setShareStatus({ kind: 'shared', url, expiresUtc: record.expires_utc, copied: true });
    } catch (err) {
      const message =
        err instanceof ShareApiError
          ? shareErrorMessage(err)
          : 'Could not create the share link. Please try again.';
      void reportError({
        baseUrl: apiBaseUrl,
        token,
        route: '/chat/shares',
        error: err,
        status: err instanceof ShareApiError ? err.status : null,
        metadata: { kind: 'share' },
      });
      setShareStatus({ kind: 'error', message });
    }
  }, [token, activeConversation, messages, module, apiBaseUrl]);

  const notifyAnswerReady = useCallback((conversationTitle: string) => {
    if (
      !enableNotifications
      || typeof document === 'undefined'
      || !document.hidden
      || typeof window === 'undefined'
      || !('Notification' in window)
      || window.Notification.permission !== 'granted'
    ) {
      return;
    }
    try {
      new window.Notification('PetroBrain answer ready', {
        body: conversationTitle ? `${conversationTitle} is ready.` : 'Your answer is ready.',
        tag: 'petrobrain-answer-ready',
      });
    } catch {
      // The browser can still deny notification display after permission changes.
    }
  }, [enableNotifications]);

  useEffect(() => {
    if (shareStatus.kind !== 'error') return;
    const timeout = setTimeout(() => setShareStatus({ kind: 'idle' }), 6000);
    return () => clearTimeout(timeout);
  }, [shareStatus]);

  // When the principal arrives but no chat is active, do nothing - the
  // user lands on the empty state and we create a conversation on first
  // send. This avoids spamming localStorage with empty "New chat" rows.

  const send = useCallback(
    async (text: string, attachments: MessageAttachment[] = []) => {
      if (!token || !principal || !ownerKey || sending) return;
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      // Create the conversation lazily on the first send so empty threads
      // never accumulate in the sidebar. New chats inherit the active
      // project so the workspace's instructions apply automatically.
      let convoId = activeId;
      if (!convoId || conversations[convoId]?.ownerKey !== ownerKey) {
        convoId = newConversation(ownerKey, activeProject?.id ?? null);
      }

      const baseMessages = conversations[convoId]?.messages ?? [];
      const exportFormat = attachments.length === 0 ? detectAnswerExportRequest(trimmed) : null;
      if (exportFormat) {
        const userMsg: Message = {
          id: nextId('u'),
          role: 'user',
          text: trimmed,
          module,
          assetContext,
          createdAt: Date.now(),
        };
        const target = findLastExportableAssistantMessage(baseMessages);
        const title = conversations[convoId]?.title || 'PetroBrain answer';
        const confirmation = target
          ? exportAssistantAnswer(target, exportFormat, title)
          : 'I need an answer to export first. Ask PetroBrain a question, then request PDF, Word, Markdown, or text export.';
        const assistantMsg: AssistantMessage = {
          id: nextId('a'),
          role: 'assistant',
          text: confirmation,
          citations: [],
          toolResults: [],
          evidencePack: null,
          flags: [],
          streaming: false,
          createdAt: Date.now(),
        };
        setMessagesInStore(convoId, [...baseMessages, userMsg, assistantMsg], ownerKey);
        if (baseMessages.length === 0) {
          setTitleFromFirstMessage(convoId, trimmed || 'Document export');
        }
        setError(null);
        return;
      }

      // Backend now receives attachments natively: images and documents
      // (PDF/DOCX) go up as base64 so the orchestrator can render the image
      // block or extract text in-process via pdfplumber/python-docx.
      // Text-style files are inlined as UTF-8 upstream.
      const wireAttachments = attachments.map((a) => ({
        name: a.name,
        kind: a.kind,
        mime_type: a.mimeType,
        // Backend wants the raw base64 payload only; strip the data-URL
        // prefix for both image and document kinds.
        data:
          (a.kind === 'image' || a.kind === 'document') && a.preview
            ? a.preview.replace(/^data:[^;]+;base64,/, '')
            : a.kind === 'text'
              ? a.preview
              : null,
      }));

      const userMsg: Message = {
        id: nextId('u'),
        role: 'user',
        text: trimmed,
        module,
        assetContext,
        createdAt: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      const assistantId = nextId('a');
      const assistantMsg: AssistantMessage = {
        id: assistantId,
        role: 'assistant',
        text: '',
        citations: [],
        toolResults: [],
        evidencePack: null,
        flags: [],
        streaming: true,
        createdAt: Date.now(),
      };

      let workingMessages: Message[] = [...baseMessages, userMsg, assistantMsg];
      setMessagesInStore(convoId, workingMessages, ownerKey);

      // Title the conversation from the first user prompt.
      if (baseMessages.length === 0) {
        setTitleFromFirstMessage(convoId, trimmed || attachments[0]?.name || 'New chat');
      }
      const notificationTitle =
        baseMessages.length === 0
          ? trimmed || attachments[0]?.name || 'New chat'
          : conversations[convoId]?.title || 'PetroBrain';

      setError(null);
      setSending(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // On the first turn of a chat we attach standing context - the
      // user's global custom instructions and any project-level
      // instructions. We only do this once per conversation; after that
      // the context lives in the message history and reattaching would
      // balloon the prompt for no benefit.
      const isFirstTurn = baseMessages.length === 0;
      const userInstructions =
        isFirstTurn && customInstructions.trim() ? customInstructions.trim() : '';
      const projectInstructions =
        isFirstTurn && activeProject?.instructions.trim()
          ? activeProject.instructions.trim()
          : '';
      const prefixBlocks: string[] = [];
      if (userInstructions) {
        prefixBlocks.push(`<user_instructions>\n${userInstructions}\n</user_instructions>`);
      }
      if (projectInstructions) {
        prefixBlocks.push(
          `<project_instructions>\n${projectInstructions}\n</project_instructions>`,
        );
      }
      const wireMessage = prefixBlocks.length > 0
        ? `${prefixBlocks.join('\n\n')}\n\n${trimmed}`
        : trimmed;

      // Paced token render. The SSE 'token' events get pushed into this
      // streamer instead of being applied immediately; the streamer drains
      // chars at ~250/s with acceleration when the model bursts ahead, so
      // the cursor moves smoothly the way Claude/ChatGPT do. Flushed on
      // 'done' so the final assistant text is whole before notifications,
      // canvas auto-open, and the feedback chip activation read it.
      const streamer = createTokenStreamer({
        applyChars: (chars) => {
          workingMessages = workingMessages.map((m) =>
            m.id === assistantId && m.role === 'assistant'
              ? { ...m, text: m.text + chars }
              : m,
          );
          setMessagesInStore(convoId!, workingMessages, ownerKey);
        },
      });

      try {
        await streamChat({
          baseUrl: apiBaseUrl,
          token,
          body: {
            message: wireMessage,
            module,
            asset_context: assetContext,
            user_role: principal.role,
            thinking_mode: thinkingMode,
            ...(webSearchEnabled ? {} : { disable_web_search: true }),
            ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
          },
          signal: controller.signal,
          onEvent: (event) => {
            if (event.event === 'token') {
              streamer.push(event.data.text);
              return;
            }
            // Everything else (citation, tool_call, tool_result, flag,
            // done) needs the latest text in place before it lands - so
            // flush any buffered chars first, then apply the event.
            streamer.flush();
            workingMessages = applyEvent(workingMessages, assistantId, event);
            setMessagesInStore(convoId!, workingMessages, ownerKey);
          },
        });
        streamer.flush();
        notifyAnswerReady(notificationTitle);
      } catch (e) {
        // Always flush partial text - the user should see whatever did
        // stream in, both for abort (their decision) and error (so they
        // can see how far it got). For session-expired we also flush
        // because the buffered chars represent work the server already
        // sent before the token expired.
        streamer.flush();
        const wasUserAbort =
          e instanceof DOMException && e.name === 'AbortError';
        const sessionExpired = e instanceof SessionExpiredError;
        if (wasUserAbort) {
          // User clicked Stop. Keep whatever text streamed in, mark the
          // assistant turn finished, and don't surface a red error banner -
          // ChatGPT/Claude behave the same way.
          workingMessages = workingMessages.map((m) =>
            m.id === assistantId && m.role === 'assistant'
              ? { ...m, streaming: false }
              : m,
          );
          setMessagesInStore(convoId!, workingMessages, ownerKey);
        } else if (sessionExpired) {
          // Token is no longer valid. Mark the half-streamed assistant turn
          // as finished (no red error chip), clear the session so the
          // AuthGate kicks in, and let the signin page surface a friendly
          // "your session expired" banner via the store flag. The user
          // never sees the raw '401: token expired' payload.
          workingMessages = workingMessages.map((m) =>
            m.id === assistantId && m.role === 'assistant'
              ? { ...m, streaming: false }
              : m,
          );
          setMessagesInStore(convoId!, workingMessages, ownerKey);
          expireSession(e.reason);
        } else {
          const detail = e instanceof Error ? e.message : String(e);
          void reportError({
            baseUrl: apiBaseUrl,
            token,
            route: '/chat',
            error: e,
            metadata: { kind: 'chat_stream', module },
          });
          setError(detail);
          workingMessages = workingMessages.map((m) =>
            m.id === assistantId && m.role === 'assistant'
              ? { ...m, streaming: false, error: detail }
              : m,
          );
          setMessagesInStore(convoId!, workingMessages, ownerKey);
        }
      } finally {
        // Last-resort cleanup. flush() in the happy / catch paths above
        // already covers it; stop() here just ensures we never leave a
        // dangling rAF id behind if those paths somehow get skipped.
        streamer.stop();
        setSending(false);
        abortRef.current = null;
      }
    },
    [
      activeId,
      activeProject,
      apiBaseUrl,
      assetContext,
      conversations,
      customInstructions,
      expireSession,
      module,
      newConversation,
      notifyAnswerReady,
      ownerKey,
      principal,
      sending,
      setMessagesInStore,
      setTitleFromFirstMessage,
      thinkingMode,
      token,
      webSearchEnabled,
    ],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const regenerate = useCallback(
    (assistantMessageId: string) => {
      if (!ownerKey || sending) return;
      const convoId = activeId;
      if (!convoId) return;
      const convo = conversations[convoId];
      if (!convo || convo.ownerKey !== ownerKey) return;
      const idx = convo.messages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) return;
      // The user turn just before this assistant turn is what we replay.
      // Walk backwards in case there are interleaved assistant turns (there
      // shouldn't be, but be defensive).
      let userIdx = idx - 1;
      while (userIdx >= 0 && convo.messages[userIdx]!.role !== 'user') {
        userIdx -= 1;
      }
      if (userIdx < 0) return;
      const userMsg = convo.messages[userIdx];
      if (!userMsg || userMsg.role !== 'user') return;

      // Drop the failed/old assistant turn (and anything after, just in case
      // - the user already saw a finished answer, so trimming is safe), then
      // re-send the same user text + attachments.
      const trimmed = convo.messages.slice(0, idx);
      setMessagesInStore(convoId, trimmed, ownerKey);
      void send(userMsg.text, userMsg.attachments ?? []);
    },
    [activeId, conversations, ownerKey, send, sending, setMessagesInStore],
  );

  const sendFeedback = useCallback(
    (assistantMessageId: string, rating: FeedbackRating, reason?: string | null) => {
      if (!token) return;
      const convoId = activeId;
      if (!convoId) return;
      const convo = conversations[convoId];
      if (!convo || convo.ownerKey !== ownerKey) return;
      const msg = convo.messages.find(
        (m): m is AssistantMessage => m.id === assistantMessageId && m.role === 'assistant',
      );
      if (!msg?.turnId) return;
      // Optimistic local update so the chip lights up before the network call
      // returns. If the POST fails we leave the optimistic state in place -
      // the server is idempotent on (tenant, user, turn), so a retry just
      // overwrites. A surfaced error here would be more confusing than
      // helpful for a thumbs-up.
      const optimistic = convo.messages.map((m) =>
        m.id === assistantMessageId && m.role === 'assistant'
          ? {
              ...m,
              feedback: {
                rating,
                reason: reason ?? null,
                sentAt: Date.now(),
              },
            }
          : m,
      );
      setMessagesInStore(convoId, optimistic, ownerKey);
      void submitFeedback({
        baseUrl: apiBaseUrl,
        token,
        turnId: msg.turnId,
        rating,
        reason: reason ?? null,
        module: msg.toolResults[0]?.tool ? null : module,
      }).catch((err) => {
        void reportError({
          baseUrl: apiBaseUrl,
          token,
          route: '/chat/feedback',
          error: err,
          status: typeof (err as { status?: unknown }).status === 'number'
            ? (err as { status: number }).status
            : null,
          metadata: { kind: 'feedback', turn_id: msg.turnId, rating },
        });
        // Silent: the rating chip stays lit; the user can re-click to retry.
      });
    },
    [activeId, apiBaseUrl, conversations, module, ownerKey, setMessagesInStore, token],
  );

  // Abort the in-flight stream when ChatClient unmounts so a closed-tab race
  // doesn't leave a hanging fetch. We intentionally do NOT abort on activeId
  // changes: the very first send in a fresh chat goes null -> new-id mid-send,
  // and a cleanup that fires after the controller is stored would abort the
  // freshly-started stream and surface as "signal is aborted without reason"
  // on the first turn. Streams write to the convoId captured in send()'s
  // closure, so switching conversations mid-flight already lands the answer
  // in the right place without an explicit abort.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Stick-to-bottom scroll. Jumps the conversation pane to the latest
  // message whenever a new message lands or tokens stream in - unless the
  // user has scrolled up to read history, in which case we pause and let
  // them stay where they are.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const lastMessageCount = useRef(messages.length);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Composer height is dynamic (attachments, extended-mode chip, multi-line
  // text) - measure it so the jump-to-latest button can sit a fixed gap
  // ABOVE the composer instead of at a hardcoded offset that overlaps as
  // the composer grows.
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(96);
  useEffect(() => {
    const el = composerWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.height ?? 96);
      setComposerHeight((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isPinned = distanceFromBottom < 120;
    pinnedToBottomRef.current = isPinned;
    setShowJumpToBottom(!isPinned);
  }, []);

  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length > lastMessageCount.current;
    lastMessageCount.current = messages.length;
    // A *new* message always pins back to the bottom (covers the "I just
    // sent a question" case). While streaming, we follow only if the user
    // is already near the bottom.
    if (grew || pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      pinnedToBottomRef.current = true;
      setShowJumpToBottom(false);
    }
  }, [messages]);

  // Switching conversations resets the pin so the new thread lands at the
  // bottom even if the previous one was scrolled up.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  // Wait for sessionStorage to rehydrate before deciding between the chat
  // surface and the sign-in gate - otherwise a reload briefly flashes the
  // AuthGate before the persisted token lands.
  if (!hasHydrated) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading PetroBrain"
        className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20"
      >
        <div className="flex flex-col items-center gap-3">
          <span className="relative inline-flex h-12 w-12">
            <span className="absolute inset-0 rounded-full bg-primary-200/60 blur-xl dark:bg-primary-700/40" />
            <span
              aria-hidden
              className="relative inline-block h-12 w-12 rounded-full border-2 border-primary-200 border-t-primary-500 animate-spin dark:border-primary-800"
            />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-400">
            PetroBrain
          </span>
        </div>
      </div>
    );
  }
  if (!token || !principal) {
    return <AuthGate />;
  }

  return (
    <div
      className={
        sidebarCollapsed
          ? canvasMessage
            ? 'grid min-h-screen grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-0'
            : 'grid min-h-screen grid-cols-[3.5rem_minmax(0,1fr)] gap-0'
          : canvasMessage
            ? 'grid min-h-screen grid-cols-[15rem_minmax(0,1fr)_minmax(0,1fr)] gap-0'
            : 'grid min-h-screen grid-cols-[15rem_minmax(0,1fr)] gap-0'
      }
    >
      <ChatSidebar />
      <section className="relative flex h-screen flex-col overflow-hidden bg-gradient-to-b from-white via-white to-primary-50/20 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/10">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 right-[-10%] h-96 w-96 rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 left-[-10%] h-96 w-96 rounded-full bg-primary-100/40 blur-3xl dark:bg-primary-900/20"
        />

        <header className="relative z-20 flex items-center justify-between gap-4 border-b border-neutral-200/60 bg-white/60 px-7 py-3 backdrop-blur-xl dark:border-neutral-800/60 dark:bg-neutral-900/60">
          <div className="flex items-center gap-2">
            <ModulePill />
            {activeProject ? (
              <span
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-primary-200/70 bg-gradient-to-r from-primary-50 to-primary-100/70 pl-2 pr-1 text-xs font-semibold text-primary-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-primary-700/40 dark:from-primary-900/40 dark:to-primary-800/30 dark:text-primary-200"
                title={activeProject.description || activeProject.name}
              >
                <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="max-w-[14rem] truncate">{activeProject.name}</span>
                <button
                  type="button"
                  onClick={() => selectProject(null)}
                  aria-label="Exit project"
                  title="Exit project"
                  className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-full text-primary-700/60 hover:bg-white/70 hover:text-primary-800 dark:text-primary-300/60 dark:hover:bg-neutral-900/60 dark:hover:text-primary-200"
                >
                  <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
                    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => activeConversation && exportConversationPdf(activeConversation)}
              disabled={!activeConversation || !isExportable(messages)}
              title="Export this conversation as PDF"
              aria-label="Export conversation as PDF"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200/70 bg-white/80 text-neutral-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.25)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path
                  d="M6 3h6l4 4v9a1.5 1.5 0 01-1.5 1.5h-8.5A1.5 1.5 0 014.5 16V4.5A1.5 1.5 0 016 3z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path d="M11.5 3v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M10 9v5m0 0l-2-2m2 2l2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={share}
              disabled={!activeConversation || !isExportable(messages) || shareStatus.kind === 'minting'}
              title="Share this conversation with your team (30-day link)"
              aria-label="Share conversation"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-200/70 bg-white/80 px-3 text-sm font-medium text-neutral-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.25)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-200 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
            >
              {shareStatus.kind === 'minting' ? (
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden className="animate-spin">
                  <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                  <path d="M17 10a7 7 0 00-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path d="M7.5 12L12.5 8M7.5 8L12.5 12" stroke="currentColor" strokeWidth="0" />
                  <circle cx="5" cy="10" r="2.25" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="15" cy="5" r="2.25" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="15" cy="15" r="2.25" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M6.8 8.8L13.2 5.7M6.8 11.2L13.2 14.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              Share
            </button>
            <button
              type="button"
              onClick={() => ownerKey && newConversation(ownerKey, activeProject?.id ?? null)}
              disabled={!ownerKey}
              className="group relative isolate inline-flex h-9 items-center gap-1.5 rounded-full bg-gradient-to-b from-neutral-900 to-neutral-800 px-3.5 text-sm font-semibold text-white shadow-[0_6px_14px_-6px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.15)] transition-all hover:from-neutral-800 hover:to-neutral-700 hover:shadow-[0_10px_24px_-8px_rgba(15,23,42,0.45)] disabled:cursor-not-allowed disabled:opacity-50 dark:from-primary-700 dark:to-primary-800 dark:hover:from-primary-600 dark:hover:to-primary-700"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              New chat
            </button>
          </div>
        </header>

        {shareStatus.kind === 'error' ? (
          <div className="relative z-20 border-b border-danger-border bg-danger-bg px-7 py-2 text-xs text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg">
            {shareStatus.message}
          </div>
        ) : null}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`relative z-10 flex-1 ${
            messages.length === 0 ? 'overflow-hidden' : 'overflow-y-auto'
          }`}
        >
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState onPrompt={send} />
            </div>
          ) : (
            <MessageList
              messages={messages}
              onRegenerate={regenerate}
              onOpenCanvas={openCanvas}
              canvasMessageId={canvasMessageId}
              onFeedback={sendFeedback}
            />
          )}
        </div>
        {showJumpToBottom && messages.length > 0 ? (
          <button
            type="button"
            onClick={scrollToLatest}
            style={{ bottom: composerHeight + 16 }}
            className="absolute left-1/2 z-30 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full border border-white/25 bg-neutral-950/85 text-white shadow-[0_18px_45px_-18px_rgba(15,23,42,0.9),inset_0_1px_0_rgba(255,255,255,0.24)] backdrop-blur transition hover:-translate-y-0.5 hover:bg-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 dark:border-white/15 dark:bg-neutral-100/15 dark:text-white dark:hover:bg-neutral-100/25"
            aria-label="Jump to latest message"
            title="Jump to latest message"
          >
            <svg
              aria-hidden="true"
              className="h-6 w-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        ) : null}
        {error ? (
          <div className="relative z-10 border-t border-danger-border bg-danger-bg px-6 py-2 text-sm text-danger-fg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg">
            {error}
          </div>
        ) : null}
        <div ref={composerWrapRef}>
          <ChatComposer
            onSubmit={send}
            disabled={!token}
            sending={sending}
            onStop={stop}
          />
        </div>
      </section>
      {canvasMessage ? (
        <CanvasPanel message={canvasMessage} onClose={closeCanvas} />
      ) : null}
      {shareStatus.kind === 'shared' && activeConversation ? (
        <ShareDialog
          title={activeConversation.title || 'PetroBrain conversation'}
          url={shareStatus.url}
          expiresUtc={shareStatus.expiresUtc}
          copied={shareStatus.copied}
          snippet={deriveShareSnippet(messages)}
          onCopy={() => void copyShareLink(shareStatus.url)}
          onClose={closeShareModal}
        />
      ) : null}
    </div>
  );
}

function shareErrorMessage(err: ShareApiError): string {
  if (err.status === 401) {
    return 'Your sign-in has expired. Sign in again to create a share link.';
  }
  if (err.status === 403) {
    return 'You do not have permission to share this conversation.';
  }
  return 'Could not create the share link. Please try again.';
}

function ShareDialog({
  title,
  url,
  expiresUtc,
  copied,
  snippet,
  onCopy,
  onClose,
}: {
  title: string;
  url: string;
  expiresUtc: string;
  copied: boolean;
  snippet: string;
  onCopy: () => void;
  onClose: () => void;
}) {
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);
  const expiresLabel = new Date(expiresUtc).toLocaleDateString();
  const emailSubject = encodeURIComponent(`PetroBrain handoff: ${title}`);
  const emailBody = encodeURIComponent(
    `${title}\n\nOpen this PetroBrain read-only handoff until ${expiresLabel}:\n${url}\n`,
  );
  const shareTargets: {
    label: string;
    href: string;
    icon: 'email' | 'linkedin';
    detail: string;
  }[] = [
    {
      label: 'Email',
      href: `mailto:?subject=${emailSubject}&body=${emailBody}`,
      icon: 'email',
      detail: 'Send brief',
    },
    {
      label: 'LinkedIn',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}&title=${encodedTitle}`,
      icon: 'linkedin',
      detail: 'Post update',
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-8 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-[38rem] overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-950 shadow-[0_28px_80px_-28px_rgba(15,23,42,0.55)] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50">
        <div className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-primary-500 via-cyan-500 to-emerald-500" />
        <div className="border-b border-slate-200 bg-slate-50/90 px-6 py-5 dark:border-slate-800 dark:bg-slate-900/80">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-primary-200 bg-primary-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-700 dark:border-primary-700/50 dark:bg-primary-900/30 dark:text-primary-200">
                  PetroBrain handoff
                </span>
                <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-700 dark:border-cyan-700/50 dark:bg-cyan-900/30 dark:text-cyan-200">
                  Read-only
                </span>
              </div>
              <h2 id="share-dialog-title" className="text-2xl font-semibold tracking-tight">
                Conversation package ready
              </h2>
              <p className="mt-1 max-w-[30rem] text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                Link copied. Teammates with access can open this snapshot until {expiresLabel}.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close share dialog"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] dark:border-slate-800 dark:bg-slate-900">
            <div className="grid grid-cols-[0.9rem_1fr] border-b border-slate-200 dark:border-slate-800">
              <div className="bg-slate-900 dark:bg-slate-800" />
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    Operations brief
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {title}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    Access
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                    Tenant scoped
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 p-4 sm:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  Conversation summary
                </p>
                <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                  {snippet || title}
                </p>
              </div>
              <div className="grid gap-2">
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    Status
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {copied ? 'Copied to clipboard' : 'Ready to copy'}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    Expires
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {expiresLabel}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                PetroBrain operations console
              </p>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Share active</span>
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={onCopy}
              className="flex h-14 items-center gap-3 rounded-xl border border-slate-200 bg-slate-900 px-4 text-left text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 dark:border-slate-700 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 dark:bg-slate-950/10">
                {copied ? (
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
                    <path d="M4 10.5L8 14.5L16 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
                    <path d="M8.5 11.5l3-3M7 6.5l-.8.8a4 4 0 005.7 5.7l.8-.8M13 13.5l.8-.8a4 4 0 00-5.7-5.7l-.8.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                )}
              </span>
              <span>
                <span className="block text-sm font-semibold">{copied ? 'Copied' : 'Copy link'}</span>
                <span className="block text-[11px] text-white/65 dark:text-slate-600">Clipboard</span>
              </span>
            </button>
            {shareTargets.map((target) => (
              <a
                key={target.label}
                href={target.href}
                target={target.icon === 'email' ? undefined : '_blank'}
                rel="noopener noreferrer"
                className="flex h-14 items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 text-left text-slate-800 transition hover:border-primary-300 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-primary-600 dark:hover:bg-primary-900/20"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-200">
                  <ShareTargetIcon kind={target.icon} />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{target.label}</span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    {target.detail}
                  </span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareTargetIcon({ kind }: { kind: 'email' | 'linkedin' }) {
  if (kind === 'email') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 5.5l7 5 7-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  // LinkedIn glyph (the "in" mark).
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <rect x="2.5" y="2.5" width="15" height="15" rx="2" fill="currentColor" opacity="0" />
      <path d="M4.5 7.5h2v8h-2v-8zm1-3.2a1.15 1.15 0 110 2.3 1.15 1.15 0 010-2.3zM8.5 7.5h1.9v1.1c.27-.51 1.1-1.2 2.3-1.2 2.46 0 2.8 1.6 2.8 3.7v4.4h-2v-3.9c0-.93-.02-2.13-1.3-2.13-1.3 0-1.5 1.02-1.5 2.07v3.96h-2v-8z" />
    </svg>
  );
}

/**
 * Pull a short, human-meaningful preview from a conversation - the first
 * user prompt, trimmed to a single line. Used by the share dialog's preview
 * card so the receiver knows what they're about to open.
 */
function deriveShareSnippet(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim()) {
      return m.text.trim().split(/\s*\n\s*/, 1)[0]!.slice(0, 220);
    }
  }
  return '';
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
      case 'done': {
        // Only spread turnId when we actually got one - strict optional-
        // property typing rejects an explicit `undefined` assignment.
        const resolvedTurnId = event.data.turn_id ?? m.turnId;
        const finalText = event.data.answer?.trim() ? event.data.answer : m.text;
        const base = {
          ...m,
          text: finalText.trim() ? finalText : fallbackCompletedAnswer(event.data.tool_results ?? m.toolResults),
          toolResults: (event.data.tool_results as ToolResult[]) ?? m.toolResults,
          evidencePack: event.data.evidence_pack ?? m.evidencePack,
          flags: event.data.flags ?? m.flags,
          streaming: false as const,
        };
        return resolvedTurnId ? { ...base, turnId: resolvedTurnId } : base;
      }
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

/**
 * Last-resort copy for an assistant bubble that finalized without text.
 *
 * The backend's _safe_answer_text(...) in app.core.orchestrator already turns
 * "tools ran but the model produced no prose" into a useful summary before
 * the `done` event leaves the server. So this function only fires when
 * something further downstream went wrong - SSE truncated mid-stream, a
 * proxy buffered out the final tokens, an older orchestrator skipped the
 * safe path. In all of those cases the truthful framing is "the response
 * was interrupted", not "I couldn't answer" (the latter suggests the model
 * failed to respond, when in fact our pipeline dropped it).
 *
 * Keeping this honest helps the user retry instead of rephrasing.
 */
function fallbackCompletedAnswer(toolResults: unknown[]): string {
  const hasToolWork = Array.isArray(toolResults) && toolResults.length > 0;
  if (hasToolWork) {
    return 'The response was interrupted after the tools returned. Please retry to get the full answer.';
  }
  return 'The response was interrupted before it finished. Please retry.';
}
