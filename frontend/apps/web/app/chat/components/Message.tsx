'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

import { Banner, Badge, Logo } from '@petrobrain/ui';
import type { Citation } from '@petrobrain/types';

import type {
  AssistantMessage,
  FeedbackRating,
  Message as MessageType,
} from '@/lib/chat/types';
import { isCanvasWorthy } from '@/lib/chat/canvas';

import { Markdown } from './Markdown';
import { ThinkingIndicator } from './ThinkingIndicator';
import { EvidencePanel } from './EvidencePanel';
import { ResearchProgressPanel } from './ResearchProgressPanel';
import { userSafeToolLabel, WorkingPanel } from './WorkingPanel';

const FLAG_BANNERS: Record<string, { tone: 'danger' | 'warn' | 'info'; title: string }> = {
  safety_bypass: { tone: 'danger', title: "I can't help with bypassing a safety system." },
  live_event: { tone: 'danger', title: 'IMMEDIATE ACTION FIRST' },
  unverified_numbers: { tone: 'warn', title: 'Unverified numbers - confirm before acting.' },
  missing_safety_banner: { tone: 'warn', title: 'Safety banner missing - verify with the competent person.' },
  domain_lock: { tone: 'info', title: 'Question outside the oil & gas domain.' },
  llm_configuration_error: { tone: 'danger', title: 'LLM provider is not configured.' },
};

export interface MessageProps {
  message: MessageType;
  onRegenerate?: (assistantMessageId: string) => void;
  onOpenCanvas?: (assistantMessageId: string) => void;
  canvasMessageId?: string | null;
  onFeedback?: (assistantMessageId: string, rating: FeedbackRating, reason?: string | null) => void;
}

export function Message({
  message, onRegenerate, onOpenCanvas, canvasMessageId, onFeedback,
}: MessageProps) {
  if (message.role === 'user') return <UserMessageView message={message} />;
  return (
    <AssistantMessageView
      message={message}
      {...(onRegenerate ? { onRegenerate } : {})}
      {...(onOpenCanvas ? { onOpenCanvas } : {})}
      {...(canvasMessageId !== undefined ? { canvasMessageId } : {})}
      {...(onFeedback ? { onFeedback } : {})}
    />
  );
}

function UserMessageView({
  message,
}: {
  message: Extract<MessageType, { role: 'user' }>;
}) {
  return (
    <article
      aria-label="Your message"
      className="ml-auto max-w-[80%] rounded-2xl rounded-tr-md bg-gradient-to-br from-primary-50 to-primary-100/80 px-4 py-3 text-neutral-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-primary-200/60 dark:from-primary-900/40 dark:to-primary-800/40 dark:text-primary-100 dark:ring-primary-700/40"
    >
      {message.attachments && message.attachments.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
          {message.attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-1.5 rounded-lg border border-primary-200 bg-white/70 px-1 py-0.5 dark:border-primary-700/40 dark:bg-neutral-900/60"
            >
              {a.kind === 'image' && a.preview ? (
                <img src={a.preview} alt={a.name} className="h-8 w-8 rounded-md object-cover" />
              ) : (
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-100 text-primary-600 dark:bg-primary-900/40 dark:text-primary-300"
                >
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                    <path
                      d="M6 3h6l4 4v9a1.5 1.5 0 01-1.5 1.5h-8.5A1.5 1.5 0 014.5 16V4.5A1.5 1.5 0 016 3z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <path d="M12 3v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
              <span className="max-w-[10rem] truncate pr-1.5 text-[11px] font-medium text-neutral-700 dark:text-neutral-300" title={a.name}>
                {a.name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {message.text ? (
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-800 dark:text-primary-100">
          {message.text}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary-700/70 dark:text-primary-300/70">
        <span>{moduleLabel(message.module)}</span>
        {message.modulePinned ? <span>· pinned</span> : null}
        {message.assetContext ? <span>· asset: {message.assetContext}</span> : null}
      </div>
      {message.routingNotice ? (
        <p
          role={message.routingWarning ? 'alert' : 'status'}
          className={clsx(
            'mt-2 rounded-lg px-2.5 py-1.5 text-[11px] normal-case tracking-normal',
            message.routingWarning
              ? 'bg-amber-100/80 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
              : 'bg-white/65 text-primary-800 dark:bg-neutral-900/45 dark:text-primary-200',
          )}
        >
          {message.routingNotice}
        </p>
      ) : null}
    </article>
  );
}

function moduleLabel(module: Extract<MessageType, { role: 'user' }>['module']): string {
  return {
    general: 'General',
    research: 'Research',
    well_control: 'Well Control',
    emissions_mrv: 'Emissions / MRV',
    ptw: 'PTW',
    documents: 'Documents',
    tasks: 'Tasks',
    audit: 'Audit',
  }[module];
}

function AssistantMessageView({
  message,
  onRegenerate,
  onOpenCanvas,
  canvasMessageId,
  onFeedback,
}: {
  message: AssistantMessage;
  onRegenerate?: (assistantMessageId: string) => void;
  onOpenCanvas?: (assistantMessageId: string) => void;
  canvasMessageId?: string | null;
  onFeedback?: (assistantMessageId: string, rating: FeedbackRating, reason?: string | null) => void;
}) {
  const safetyToolResult = message.toolResults.find(
    (tr) =>
      isObject(tr.result) &&
      (typeof tr.result['banner'] === 'string' || tr.result['safety_critical'] === true),
  );
  const banners = collectBanners(message, safetyToolResult);
  const isSafetyCritical = Boolean(safetyToolResult);

  const hasText = message.text.length > 0;
  const hasWork = message.toolResults.length > 0 || message.citations.length > 0;
  const workingSteps = message.workingSteps ?? [];
  const progressSources = message.progressSources ?? [];
  // Hide the "Thinking" pulse as soon as any signal arrives - a tool call
  // running, a citation streaming in, or the first token - so it never
  // lingers next to a panel that already shows progress.
  const isThinking = message.streaming && !hasText && !hasWork && workingSteps.length === 0;
  const isFinal = !message.streaming && !message.error;

  return (
    <article aria-label="PetroBrain response" className="group flex gap-3">
      <div className="mt-1 shrink-0">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-50 to-primary-100 ring-1 ring-primary-200/70 dark:from-primary-900/40 dark:to-primary-800/40 dark:ring-primary-700/40"
        >
          <Logo size={20} />
        </span>
      </div>

      <div className="min-w-0 flex-1 space-y-2.5">
        <header className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">PetroBrain</span>
            {message.error ? <Badge tone="danger">error</Badge> : null}
          </div>
        </header>

        {banners.map((b) => (
          <Banner key={b.key} tone={b.tone} title={b.title}>
            {b.body}
          </Banner>
        ))}

        {isThinking ? <ThinkingIndicator /> : null}

        {workingSteps.length > 0 ? (
          <ResearchProgressPanel
            steps={workingSteps}
            sources={progressSources}
            streaming={message.streaming}
          />
        ) : null}

        {hasText ? (
          <div className="prose-pb">
            <Markdown>{message.text}</Markdown>
            {message.streaming ? (
              <span
                aria-hidden
                className="ml-0.5 inline-block h-[1.05em] w-[2px] -mb-0.5 translate-y-[3px] bg-primary-500 align-baseline animate-pb-caret"
              />
            ) : null}
          </div>
        ) : null}

        <EvidencePanel evidence={message.evidencePack} />

        {message.citations.length > 0 ? (
          <SourcesFooter citations={message.citations} />
        ) : null}

        {message.toolResults.length > 0 ? (
          <WorkingTrace toolResults={message.toolResults} defaultOpen={isSafetyCritical} />
        ) : null}

        {message.error ? (
          <p role="alert" className="text-xs text-danger-fg dark:text-danger-bg">
            {message.error}
          </p>
        ) : null}

        {isFinal && hasText ? (
          <div className="flex flex-wrap items-center gap-2">
            <AssistantToolbar
              text={message.text}
              messageId={message.id}
              {...(onRegenerate ? { onRegenerate } : {})}
            />
            <FeedbackChips
              message={message}
              {...(onFeedback ? { onFeedback } : {})}
            />
            {onOpenCanvas && isCanvasWorthy(message) && canvasMessageId !== message.id ? (
              <button
                type="button"
                onClick={() => onOpenCanvas(message.id)}
                title="Open this response in the canvas side panel"
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-neutral-200/80 bg-white px-2.5 text-[11px] font-medium text-neutral-600 transition-all hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-primary-900/30 dark:hover:text-primary-300"
              >
                <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path
                    d="M4 5.5A1.5 1.5 0 015.5 4h9A1.5 1.5 0 0116 5.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 14.5v-9z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path d="M11 4v12M11 9h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Open in canvas
              </button>
            ) : null}
            {canvasMessageId === message.id ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-primary-200/70 bg-primary-50 px-2.5 text-[11px] font-medium text-primary-700 dark:border-primary-700/40 dark:bg-primary-900/30 dark:text-primary-300">
                <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path d="M5 10.5L8.5 14L15 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Open in canvas
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function WorkingTrace({
  toolResults,
  defaultOpen,
}: {
  toolResults: AssistantMessage['toolResults'];
  defaultOpen?: boolean;
}) {
  const summary = summariseTools(toolResults);
  return (
    <details open={defaultOpen} className="group mt-1">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
        <svg
          width="11"
          height="11"
          viewBox="0 0 20 20"
          fill="none"
          className="transition-transform [details[open]_&]:rotate-90"
        >
          <path
            d="M7 5l6 5-6 5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{summary}</span>
      </summary>
      <div className="mt-2 space-y-3 border-l-2 border-neutral-200/70 pl-3.5 dark:border-neutral-800/70">
        {toolResults.map((tr, i) => (
          <WorkingPanel
            key={`${tr.tool}-${i}`}
            tool={tr.tool}
            input={tr.input}
            result={tr.result}
            defaultOpen={defaultOpen ?? false}
          />
        ))}
      </div>
    </details>
  );
}

function summariseTools(results: AssistantMessage['toolResults']): string {
  if (results.length === 0) return 'No background work';
  if (results.length === 1) {
    const name = results[0]!.tool;
    if (name === 'web_search') return 'Searched the web';
    return userSafeToolLabel(name);
  }
  return `Completed ${results.length} checks`;
}

function SourcesFooter({ citations }: { citations: Citation[] }) {
  // Two kinds of citations live here: web-sourced (carry a ``url``, came from
  // the Tavily tool) and SOP-sourced (no url, came from the tenant's RAG
  // corpus). Both render compactly in a single row; web ones become external
  // links with the domain as the visible label, SOP ones stay as in-app
  // chips with their existing title/clause label.
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_LIMIT = 4;
  const visible = expanded ? citations : citations.slice(0, COLLAPSED_LIMIT);
  const overflow = citations.length - visible.length;

  return (
    <section aria-label="Sources" className="space-y-1.5 pt-1">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
        Sources
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {visible.map((c, i) => (
          <SourcePill key={`${c.title ?? ''}-${c.url ?? ''}-${c.clause ?? ''}-${i}`} index={i + 1} citation={c} />
        ))}
        {overflow > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex h-6 items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 text-[11px] font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:text-primary-300"
          >
            +{overflow} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SourcePill({ index, citation }: { index: number; citation: Citation }) {
  const label = compactLabel(citation);
  const title = fullTitle(citation);
  const className =
    'group inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 text-[11px] font-medium text-neutral-700 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-200 dark:hover:border-primary-600 dark:hover:bg-primary-900/30 dark:hover:text-primary-200';

  const indexBadge = (
    <span className="text-[10px] font-semibold text-neutral-400 group-hover:text-primary-500 dark:text-neutral-500 dark:group-hover:text-primary-400">
      {index}
    </span>
  );

  if (citation.url) {
    return (
      <a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={`Open source ${index}: ${title}`}
        className={className}
      >
        {indexBadge}
        <span className="truncate">{label}</span>
        {citation.reliability ? (
          <span className="text-[9px] uppercase tracking-wide text-neutral-400 group-hover:text-primary-500 dark:text-neutral-500">
            {citation.reliability}
          </span>
        ) : null}
      </a>
    );
  }
  return (
    <span title={title} className={className}>
      {indexBadge}
      <span className="truncate">{label}</span>
      {citation.reliability ? (
        <span className="text-[9px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {citation.reliability}
        </span>
      ) : null}
    </span>
  );
}

function compactLabel(c: Citation): string {
  if (c.url) {
    try {
      return new URL(c.url).hostname.replace(/^www\./, '');
    } catch {
      return c.url;
    }
  }
  if (c.title) return c.title;
  if (c.clause) return `§${c.clause}`;
  return 'source';
}

function fullTitle(c: Citation): string {
  const parts: string[] = [];
  if (c.title) parts.push(c.title);
  if (c.revision) parts.push(c.revision);
  if (c.clause) parts.push(`§${c.clause}`);
  if (c.reliability) parts.push(`${c.reliability} reliability`);
  if (c.freshness) parts.push(`${c.freshness} freshness`);
  if (c.url) parts.push(c.url);
  return parts.join(' · ') || 'source';
}

interface AssistantToolbarProps {
  text: string;
  messageId: string;
  onRegenerate?: (assistantMessageId: string) => void;
}

function AssistantToolbar({ text, messageId, onRegenerate }: AssistantToolbarProps) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechStartTimerRef = useRef<number | null>(null);
  const canReadAloud =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';

  useEffect(() => {
    return () => {
      if (speechStartTimerRef.current !== null) {
        window.clearTimeout(speechStartTimerRef.current);
      }
      if (utteranceRef.current && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard permission missing in some contexts - silently no-op.
    }
  }

  function readAloud() {
    if (!canReadAloud) return;
    if (speaking) {
      if (speechStartTimerRef.current !== null) {
        window.clearTimeout(speechStartTimerRef.current);
        speechStartTimerRef.current = null;
      }
      window.speechSynthesis.cancel();
      utteranceRef.current = null;
      setSpeaking(false);
      return;
    }

    const spokenText = speechTextFromMarkdown(text);
    if (!spokenText) return;

    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang =
      document.documentElement.lang || navigator.language || 'en-US';
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    const finishSpeaking = () => {
      utteranceRef.current = null;
      speechStartTimerRef.current = null;
      setSpeaking(false);
    };
    utterance.onend = finishSpeaking;
    utterance.onerror = finishSpeaking;

    window.speechSynthesis.cancel();
    utteranceRef.current = utterance;
    setSpeaking(true);
    // Chromium can ignore speak() when it immediately follows cancel().
    // Starting on the next task makes repeated read/stop/read actions reliable.
    speechStartTimerRef.current = window.setTimeout(() => {
      speechStartTimerRef.current = null;
      if (utteranceRef.current === utterance) {
        window.speechSynthesis.speak(utterance);
      }
    }, 50);
  }

  return (
    <div
      className="flex items-center gap-1 pt-1 opacity-70 transition-opacity group-hover:opacity-100"
      aria-label="Response actions"
    >
      <IconButton
        label={copied ? 'Copied' : 'Copy'}
        onClick={copy}
        active={copied}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
      {canReadAloud ? (
        <IconButton
          label={speaking ? 'Stop reading' : 'Read aloud'}
          onClick={readAloud}
          active={speaking}
        >
          {speaking ? <StopAudioIcon /> : <SpeakerIcon />}
        </IconButton>
      ) : null}
      {onRegenerate ? (
        <IconButton label="Regenerate" onClick={() => onRegenerate(messageId)}>
          <RegenerateIcon />
        </IconButton>
      ) : null}
    </div>
  );
}

export function speechTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors',
        'hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300',
        'dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
        active && 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-200',
      )}
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
      <rect x="6" y="6" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 14V5.5A1.5 1.5 0 015.5 4H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
      <path d="M4 10.5L8 14.5L16 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
      <path
        d="M4 8.5v3h3l4 3.5v-10L7 8.5H4z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14 7a4 4 0 010 6M16 5a7 7 0 010 10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StopAudioIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
      <path
        d="M4 8.5v3h3l4 3.5v-10L7 8.5H4z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 7l3 6M17 7l-3 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ThumbsUpIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill={filled ? 'currentColor' : 'none'}>
      <path
        d="M7 17V9.5L10 3a2 2 0 012 2v3h4a2 2 0 012 2.3l-1 5A2 2 0 0115 17H7zM7 9.5H4a1 1 0 00-1 1v5.5a1 1 0 001 1h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ThumbsDownIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill={filled ? 'currentColor' : 'none'}>
      <path
        d="M13 3v7.5L10 17a2 2 0 01-2-2v-3H4a2 2 0 01-2-2.3l1-5A2 2 0 015 3h8zM13 10.5h3a1 1 0 001-1V4a1 1 0 00-1-1h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Thumbs-up / thumbs-down chips next to the assistant toolbar. Clicking a
 * thumb posts feedback immediately (optimistic). Clicking thumbs-down also
 * opens a tiny reason input so the user can explain in <= a sentence.
 * Re-clicking the same thumb leaves the rating in place (server upsert is
 * idempotent); the user can swap thumbs to flip their rating.
 *
 * Disabled (and visually muted) when the message has no turnId - that's an
 * older message persisted before the feature shipped, with nothing on the
 * server to attach feedback to.
 */
function FeedbackChips({
  message,
  onFeedback,
}: {
  message: AssistantMessage;
  onFeedback?: (assistantMessageId: string, rating: FeedbackRating, reason?: string | null) => void;
}) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const sentRating = message.feedback?.rating;
  const disabled = !message.turnId || !onFeedback;

  function rate(rating: FeedbackRating) {
    if (disabled || !onFeedback) return;
    if (rating === 'down') {
      // Open the reason input on the first thumbs-down click. The rating is
      // still posted right away so a closed reason box still records the
      // signal; the textarea is optional context.
      setReasonOpen(true);
    } else {
      setReasonOpen(false);
    }
    onFeedback(message.id, rating, null);
  }

  function submitReason() {
    if (disabled || !onFeedback) return;
    const trimmed = reason.trim();
    onFeedback(message.id, 'down', trimmed || null);
    setReasonOpen(false);
    setReason('');
  }

  const chip = (active: boolean) =>
    clsx(
      'inline-flex h-7 items-center justify-center rounded-full border px-2 transition-all',
      disabled
        ? 'cursor-not-allowed border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-700'
        : active
          ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
          : 'border-neutral-200/80 bg-white text-neutral-500 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-primary-600 dark:hover:bg-primary-900/30 dark:hover:text-primary-300',
    );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Good answer"
          title={disabled ? 'Feedback unavailable for this message' : 'Mark this answer as helpful'}
          disabled={disabled}
          onClick={() => rate('up')}
          className={chip(sentRating === 'up')}
        >
          <ThumbsUpIcon filled={sentRating === 'up'} />
        </button>
        <button
          type="button"
          aria-label="Bad answer"
          title={disabled ? 'Feedback unavailable for this message' : 'Mark this answer as incorrect or unhelpful'}
          disabled={disabled}
          onClick={() => rate('down')}
          className={chip(sentRating === 'down')}
        >
          <ThumbsDownIcon filled={sentRating === 'down'} />
        </button>
      </div>
      {reasonOpen ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-neutral-200/80 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900">
          <label htmlFor={`fb-reason-${message.id}`} className="text-[10px] uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
            What was wrong? (optional)
          </label>
          <textarea
            id={`fb-reason-${message.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="e.g. wrong clause cited, unit conversion off by 10x, missing safety banner…"
            className="resize-none border-0 bg-transparent p-0 text-[12px] text-neutral-700 placeholder:text-neutral-400 focus:outline-none focus:ring-0 dark:text-neutral-200 dark:placeholder:text-neutral-500"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setReasonOpen(false);
                setReason('');
              }}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={submitReason}
              className="rounded-md bg-primary-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-primary-700"
            >
              Send
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RegenerateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
      <path
        d="M16 10a6 6 0 11-1.76-4.24M16 4v3.5h-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface BannerSpec {
  key: string;
  tone: 'safe' | 'info' | 'warn' | 'danger' | 'brand';
  title: string;
  body: string;
}

function collectBanners(message: AssistantMessage, safetyToolResult: { result: unknown } | undefined): BannerSpec[] {
  const out: BannerSpec[] = [];
  if (safetyToolResult && isObject(safetyToolResult.result) && typeof safetyToolResult.result['banner'] === 'string') {
    out.push({
      key: 'verification',
      tone: 'brand',
      title: 'DECISION SUPPORT ONLY',
      body: safetyToolResult.result['banner'] as string,
    });
  }
  for (const flag of message.flags) {
    const spec = FLAG_BANNERS[flag];
    if (!spec) continue;
    out.push({ key: `flag-${flag}`, tone: spec.tone, title: spec.title, body: '' });
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
