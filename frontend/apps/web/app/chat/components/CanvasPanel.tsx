'use client';

import { useEffect } from 'react';

import { Banner } from '@petrobrain/ui';

import { isStructuredToolMessage } from '@/lib/chat/canvas';
import type { AssistantMessage } from '@/lib/chat/types';

import { BottomSheet } from './BottomSheet';
import { EvidencePanel } from './EvidencePanel';
import { Markdown } from './Markdown';
import { userSafeToolLabel } from './WorkingPanel';

export function CanvasPanel({
  message,
  onClose,
}: {
  message: AssistantMessage;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const structured = isStructuredToolMessage(message);
  const safetyToolResult = message.toolResults.find(
    (tr) =>
      tr.result && typeof tr.result === 'object'
      && ((tr.result as Record<string, unknown>)['banner'] !== undefined
        || (tr.result as Record<string, unknown>)['safety_critical'] === true),
  );
  const eyebrow = structured ? 'Generated document' : 'Long-form answer';
  const createdAt = new Date(message.createdAt);

  const header = (
      <header className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200/60 bg-white/70 px-5 py-3 backdrop-blur-xl dark:border-neutral-800/60 dark:bg-neutral-900/60">
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-400">
            Canvas - {eyebrow}
          </span>
          <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">
            {createdAt.toLocaleString()}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close canvas (Esc)"
          aria-label="Close canvas"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200/70 bg-white/80 text-neutral-500 transition-all hover:border-primary-300 hover:bg-white hover:text-primary-700 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300"
        >
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>
  );

  const scrollBody = (
      <div className="relative z-10 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
        {safetyToolResult ? (
          <div className="mb-5">
            <Banner tone="brand" title="DECISION SUPPORT ONLY">
              {(safetyToolResult.result as Record<string, unknown>)['banner'] as string
                ?? 'Verify all safety-critical numbers with the competent person before acting.'}
            </Banner>
          </div>
        ) : null}

        {message.text ? (
          <article className="prose-pb max-w-none text-[15px] leading-relaxed">
            <Markdown>{message.text}</Markdown>
          </article>
        ) : (
          <p className="text-sm italic text-neutral-500 dark:text-neutral-400">
            This message has no text content.
          </p>
        )}

        <div className="mt-6">
          <EvidencePanel evidence={message.evidencePack} />
        </div>

        {message.citations.length > 0 ? (
          <section className="mt-8 border-t border-neutral-200/70 pt-5 dark:border-neutral-800/60">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
              Sources
            </h3>
            <ul className="space-y-1.5 text-sm">
              {message.citations.map((c, i) => {
                const label = [c.title, c.revision, c.clause].filter(Boolean).join(' - ');
                return (
                  <li key={`${label}-${i}`} className="text-neutral-700 dark:text-neutral-300">
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-700 hover:underline dark:text-primary-300"
                      >
                        {label || c.url}
                      </a>
                    ) : (
                      label
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {message.toolResults.length > 0 ? (
          <details className="mt-8 rounded-xl border border-neutral-200/70 bg-white/60 px-4 py-3 dark:border-neutral-800/60 dark:bg-neutral-900/60">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">
              Work completed ({message.toolResults.length})
            </summary>
            <ol className="mt-3 space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
              {message.toolResults.map((tr, i) => (
                <li key={`${tr.tool}-${i}`}>
                  {userSafeToolLabel(tr.tool)}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
  );

  return (
    <>
      {/* Desktop: docked canvas column in the chat grid. */}
      <aside
        aria-label="Canvas: expanded message"
        className="relative hidden h-dvh min-h-0 flex-col overflow-hidden border-l border-neutral-200/60 bg-gradient-to-b from-white via-white to-primary-50/30 md:flex dark:border-neutral-800/60 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 right-[-15%] h-96 w-96 rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
        />
        {header}
        {scrollBody}
      </aside>

      {/* Mobile: the same content as a full-height bottom sheet. */}
      <BottomSheet onClose={onClose} label={`Canvas: ${eyebrow}`}>
        {header}
        {scrollBody}
      </BottomSheet>
    </>
  );
}
