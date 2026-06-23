'use client';

import { useMemo } from 'react';

import { Logo } from '@petrobrain/ui';

import { useChatStore } from '@/lib/chat/store';
import { useSettingsStore } from '@/lib/chat/settings';

const SUGGESTIONS = [
  {
    title: 'Build a kill sheet',
    body: 'Well-control kill sheet from well + influx parameters.',
    prompt:
      'Build a kill sheet for 10,000 ft TVD, OMW 9.6 ppg, SIDPP 400 psi, SICP 600 psi, pit gain 20 bbl.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M4 4h12v3H4zM4 9h12v7H4z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M7 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Summarize an SOP',
    body: 'Key steps + verification points from your tenant SOPs.',
    prompt: 'Summarize the key steps and verification points in our well-control handover SOP.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M6 3h6l4 4v9a1.5 1.5 0 01-1.5 1.5h-8.5A1.5 1.5 0 014.5 16V4.5A1.5 1.5 0 016 3z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Tier-3 MRV gaps',
    body: 'Sources not yet on measurement-based Tier 3.',
    prompt:
      'Which of our emission sources are not yet on measurement-based Tier 3, against the Jan-2027 deadline?',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M3 16l4-5 3 3 4-6 3 5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

function timeOfDay(): 'morning' | 'afternoon' | 'evening' {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function displayName(userId: string): string {
  // Strip domain if userId is an email-style identifier, otherwise show as-is.
  const base = userId.includes('@') ? userId.split('@')[0]! : userId;
  // Title-case the first segment (split on . _ - space).
  const first = base.split(/[._\- ]/)[0] ?? base;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

type PromptHandler = (text: string, ...rest: never[]) => unknown;

export function EmptyState({ onPrompt }: { onPrompt?: PromptHandler }) {
  const principal = useChatStore((s) => s.principal);
  const callMeName = useSettingsStore((s) => s.callMeName);
  const displayNameSetting = useSettingsStore((s) => s.displayName);
  const name = useMemo(() => {
    const preferred = (callMeName || displayNameSetting).trim();
    if (preferred) return preferred;
    if (!principal) return 'there';
    // Fall back to the account identity. Prefer the email (every device has
    // it) over the raw userId, which is an opaque hash and renders as e.g.
    // "6b72871a" - never use it for a human-facing greeting.
    return displayName(principal.email || principal.userId);
  }, [callMeName, displayNameSetting, principal]);
  const part = timeOfDay();

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-6 text-center">
      <div className="relative">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 rounded-full bg-gradient-to-br from-primary-200/60 via-primary-300/30 to-transparent blur-2xl dark:from-primary-700/40 dark:via-primary-800/20"
        />
        <Logo size={92} glow />
      </div>

      <div className="space-y-1.5">
        <h2 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100 sm:text-4xl">
          Good {part}, <span className="text-neutral-900 dark:text-neutral-100">{name}</span>
        </h2>
        <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          <span className="text-neutral-700 dark:text-neutral-300">How can I </span>
          <span className="bg-gradient-to-r from-primary-500 to-primary-700 bg-clip-text text-transparent dark:from-primary-400 dark:to-primary-600">
            assist your operations today?
          </span>
        </h3>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
          Grounded in your tenant&apos;s SOPs, standards, and emissions data. Numbers come from the
          calculation tools - never from prose.
        </p>
      </div>

      <div className="hidden w-full grid-cols-1 gap-3 text-left sm:grid sm:grid-cols-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onPrompt?.(s.prompt)}
            disabled={!onPrompt}
            className="group relative overflow-hidden rounded-2xl border border-neutral-200/80 bg-white/80 p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:bg-white hover:shadow-[0_12px_24px_-12px_rgba(234,88,12,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-default disabled:hover:transform-none dark:border-neutral-800/70 dark:bg-neutral-900/70 dark:hover:border-primary-600 dark:hover:bg-neutral-900"
          >
            <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary-50 to-primary-100 text-primary-600 ring-1 ring-primary-200/60 transition-colors group-hover:from-primary-100 group-hover:to-primary-200 dark:from-primary-900/40 dark:to-primary-800/40 dark:text-primary-300 dark:ring-primary-700/40 dark:group-hover:from-primary-800/50 dark:group-hover:to-primary-700/50">
              {s.icon}
            </div>
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{s.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{s.body}</p>
            <span
              aria-hidden
              className="absolute right-3 top-3 text-primary-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-primary-500"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                <path
                  d="M5 10h10M11 6l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
