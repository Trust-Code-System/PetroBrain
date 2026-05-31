'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import clsx from 'clsx';

import type { Module } from '@petrobrain/types';
import { BackLink } from '@petrobrain/ui';

import { AuthGate } from '../chat/components/AuthGate';
import { ownerKeyOf, useConversationsStore } from '@/lib/chat/conversations';
import { useProjectsStore } from '@/lib/chat/projects';
import {
  useSettingsStore,
  type SendShortcut,
  type Theme,
} from '@/lib/chat/settings';
import { useChatStore } from '@/lib/chat/store';

type Section =
  | 'general'
  | 'profile'
  | 'instructions'
  | 'data'
  | 'notifications'
  | 'spoken'
  | 'account';

interface SectionDef {
  key: Section;
  label: string;
  icon: 'general' | 'profile' | 'instructions' | 'data' | 'bell' | 'mic' | 'account';
  stub?: boolean;
}

const SECTIONS: SectionDef[] = [
  { key: 'general', label: 'General', icon: 'general' },
  { key: 'profile', label: 'Profile', icon: 'profile' },
  { key: 'instructions', label: 'Custom instructions', icon: 'instructions' },
  { key: 'data', label: 'Data controls', icon: 'data' },
  { key: 'notifications', label: 'Notifications', icon: 'bell', stub: true },
  { key: 'spoken', label: 'Spoken language', icon: 'mic', stub: true },
  { key: 'account', label: 'Account', icon: 'account' },
];

const MODULE_OPTIONS: { value: Module; label: string; description: string }[] = [
  { value: 'general', label: 'General', description: 'Domain-locked Q&A across SOPs and standards.' },
  { value: 'well_control', label: 'Well Control', description: 'Kill sheets, kick detection, shut-in math.' },
  { value: 'emissions_mrv', label: 'Emissions / MRV', description: 'NUPRC Tier-3 inventories + GHGEMP.' },
];

const THEME_OPTIONS: { value: Theme; label: string; description: string }[] = [
  { value: 'system', label: 'Match system', description: 'Follow your OS light/dark preference.' },
  { value: 'light', label: 'Light', description: 'Bright surfaces, warm primary tints.' },
  { value: 'dark', label: 'Dark', description: 'Low-light surfaces for night shifts and control rooms.' },
];

function SectionIcon({ kind }: { kind: SectionDef['icon'] }) {
  const c = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none' } as const;
  switch (kind) {
    case 'general':
      return (
        <svg {...c}>
          <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10 3v1.5M10 15.5V17M17 10h-1.5M4.5 10H3M15 5l-1 1M6 14l-1 1M15 15l-1-1M6 6L5 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'profile':
      return (
        <svg {...c}>
          <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 17c.5-3 3-5 6-5s5.5 2 6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'instructions':
      return (
        <svg {...c}>
          <path
            d="M5 4h10M5 8h10M5 12h7M5 16h5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'data':
      return (
        <svg {...c}>
          <ellipse cx="10" cy="5.5" rx="6" ry="2" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4 5.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9M4 10c0 1.1 2.7 2 6 2s6-.9 6-2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      );
    case 'bell':
      return (
        <svg {...c}>
          <path
            d="M5 13l1-2V8a4 4 0 118 0v3l1 2H5zM8 16h4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'mic':
      return (
        <svg {...c}>
          <rect x="8" y="3" width="4" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M5 10a5 5 0 0010 0M10 15v2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'account':
      return (
        <svg {...c}>
          <rect x="3" y="5" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M3 9h14M7 13h2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

function Field({
  label,
  description,
  children,
  htmlFor,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-neutral-200/70 py-4 last:border-b-0 dark:border-neutral-800/70 sm:grid-cols-[1fr_minmax(220px,_360px)] sm:items-center sm:gap-6">
      <div>
        <label
          htmlFor={htmlFor}
          className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
        >
          {label}
        </label>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{description}</p>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900',
        checked ? 'bg-gradient-to-b from-primary-500 to-primary-700' : 'bg-neutral-200 dark:bg-neutral-700',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={clsx(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function ChoiceGroup<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="space-y-1.5">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <label
            key={o.value}
            className={clsx(
              'flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-all',
              selected
                ? 'border-primary-300 bg-primary-50/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-primary-600/60 dark:bg-primary-900/30'
                : 'border-neutral-200 bg-white hover:border-primary-200 hover:bg-primary-50/30 dark:border-neutral-700 dark:bg-neutral-900/60 dark:hover:border-primary-600/60 dark:hover:bg-primary-900/20',
            )}
          >
            <input
              type="radio"
              name={name}
              checked={selected}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={clsx(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                selected
                  ? 'border-primary-500 bg-primary-500'
                  : 'border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-800',
              )}
            >
              {selected ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={clsx(
                  'block text-sm font-semibold',
                  selected
                    ? 'text-primary-800 dark:text-primary-200'
                    : 'text-neutral-900 dark:text-neutral-100',
                )}
              >
                {o.label}
              </span>
              {o.description ? (
                <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {o.description}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function StubBanner({ feature }: { feature: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/60 p-5 text-center dark:border-neutral-700 dark:bg-neutral-900/60">
      <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{feature} - coming soon</p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        This section is on the roadmap. Reach out if it&apos;s blocking you and we&apos;ll
        prioritise it.
      </p>
    </div>
  );
}

function BackHeader() {
  const from = useSearchParams()?.get('from');
  const backToChat = from === 'chat';
  const href = backToChat ? '/chat' : '/';
  const label = backToChat ? 'Back to chat' : 'Back to home';
  return (
    <Link href={href} legacyBehavior passHref>
      <BackLink label={label} />
    </Link>
  );
}

export function SettingsClient() {
  const params = useSearchParams();
  const initial = (params?.get('section') as Section | null) ?? 'general';
  const [section, setSection] = useState<Section>(initial);

  const token = useChatStore((s) => s.token);
  const principal = useChatStore((s) => s.principal);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const hasChatHydrated = useChatStore((s) => s.hasHydrated);
  const setToken = useChatStore((s) => s.setToken);

  const s = useSettingsStore();
  const conversations = useConversationsStore((cs) => cs.conversations);
  const order = useConversationsStore((cs) => cs.order);
  const projects = useProjectsStore((ps) => ps.projects);

  const ownerKey = useMemo(() => ownerKeyOf(principal), [principal]);

  function downloadJson() {
    if (!ownerKey) return;
    const myConversations = order
      .map((id) => conversations[id])
      .filter((c) => c && c.ownerKey === ownerKey);
    const myProjects = Object.values(projects).filter((p) => p.ownerKey === ownerKey);
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), conversations: myConversations, projects: myProjects }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `petrobrain-export-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function clearAllChats() {
    if (!ownerKey) return;
    const confirmed = window.confirm(
      'Delete every chat in this account? This cannot be undone. Projects will be preserved.',
    );
    if (!confirmed) return;
    const cs = useConversationsStore.getState();
    for (const id of Object.keys(cs.conversations)) {
      if (cs.conversations[id]?.ownerKey === ownerKey) {
        cs.deleteConversation(id);
      }
    }
  }

  if (!hasChatHydrated) {
    return (
      <div className="grid min-h-screen place-items-center bg-gradient-to-b from-white via-white to-primary-50/30 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20">
        <span className="relative inline-flex h-12 w-12">
          <span className="absolute inset-0 rounded-full bg-primary-200/60 blur-xl dark:bg-primary-700/40" />
          <span
            aria-hidden
            className="relative inline-block h-12 w-12 rounded-full border-2 border-primary-200 border-t-primary-500 animate-spin dark:border-primary-800"
          />
        </span>
      </div>
    );
  }
  if (!token || !principal) return <AuthGate />;

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 right-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-200/30 blur-3xl dark:bg-primary-800/20"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 left-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary-100/40 blur-3xl dark:bg-primary-900/20"
      />

      <div className="relative mx-auto max-w-6xl px-6 py-10">
        <BackHeader />

        <header className="mt-4 mb-6">
          <h1 className="bg-gradient-to-br from-neutral-900 to-neutral-600 bg-clip-text text-3xl font-semibold tracking-tight text-transparent dark:from-neutral-100 dark:to-neutral-400 sm:text-4xl">
            Settings
          </h1>
        </header>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
          <nav className="space-y-0.5" aria-label="Settings sections">
            {SECTIONS.map((sec) => {
              const active = section === sec.key;
              return (
                <button
                  key={sec.key}
                  type="button"
                  onClick={() => setSection(sec.key)}
                  className={clsx(
                    'group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-all',
                    active
                      ? 'bg-gradient-to-r from-primary-50 to-primary-100/70 text-primary-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:from-primary-900/40 dark:to-primary-800/30 dark:text-primary-200'
                      : 'text-neutral-600 hover:bg-white hover:text-primary-700 dark:text-neutral-400 dark:hover:bg-neutral-900/60 dark:hover:text-primary-300',
                  )}
                >
                  <span
                    className={clsx(
                      'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                      active
                        ? 'bg-white/70 text-primary-700 dark:bg-neutral-900/60 dark:text-primary-300'
                        : 'bg-primary-50 text-primary-600 group-hover:bg-primary-100 dark:bg-primary-900/30 dark:text-primary-400 dark:group-hover:bg-primary-800/40',
                    )}
                  >
                    <SectionIcon kind={sec.icon} />
                  </span>
                  <span className="flex-1 text-left">{sec.label}</span>
                  {sec.stub ? (
                    <span className="rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
                      Soon
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <section className="min-w-0 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-brand-sm backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-900/70 sm:p-6">
            {section === 'general' ? (
              <>
                <SectionHeader title="General" subtitle="Tune how PetroBrain looks and behaves." />
                <Field
                  label="Theme"
                  description="Switch between light and dark surfaces, or follow your OS preference."
                >
                  <ChoiceGroup<Theme>
                    name="theme"
                    value={s.theme}
                    onChange={s.setTheme}
                    options={THEME_OPTIONS}
                  />
                </Field>
                <Field
                  label="Send shortcut"
                  description="Which keystroke submits the composer."
                >
                  <ChoiceGroup<SendShortcut>
                    name="send-shortcut"
                    value={s.sendShortcut}
                    onChange={s.setSendShortcut}
                    options={[
                      { value: 'enter', label: 'Enter to send', description: 'Shift+Enter inserts a newline.' },
                      { value: 'shift_enter', label: 'Shift+Enter to send', description: 'Plain Enter inserts a newline.' },
                    ]}
                  />
                </Field>
                <Field
                  label="Default module"
                  description="Preselected when you start a new chat."
                >
                  <ChoiceGroup<Module>
                    name="default-module"
                    value={s.defaultModule}
                    onChange={s.setDefaultModule}
                    options={MODULE_OPTIONS}
                  />
                </Field>
                <Field
                  label="Render markdown in answers"
                  description="Bold, lists, tables, code blocks. Turn off for plain text."
                >
                  <div className="flex justify-end">
                    <Toggle
                      label="Render markdown"
                      checked={s.renderMarkdown}
                      onChange={s.setRenderMarkdown}
                    />
                  </div>
                </Field>
              </>
            ) : null}

            {section === 'profile' ? (
              <>
                <SectionHeader title="Profile" subtitle="What PetroBrain calls you and how it sees you." />
                <Field
                  label="Display name"
                  description="Used in the greeting and elsewhere. Defaults to your account name."
                  htmlFor="display-name"
                >
                  <input
                    id="display-name"
                    value={s.displayName}
                    onChange={(e) => s.setDisplayName(e.target.value)}
                    placeholder={principal.userId}
                    className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
                  />
                </Field>
                <Field
                  label="What should PetroBrain call you?"
                  description="Overrides the display name in greetings."
                  htmlFor="call-me"
                >
                  <input
                    id="call-me"
                    value={s.callMeName}
                    onChange={(e) => s.setCallMeName(e.target.value)}
                    placeholder="e.g. Judha"
                    className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
                  />
                </Field>
                <Field label="Account identity" description="Read-only - comes from your JWT.">
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-xl border border-neutral-100 bg-neutral-50/60 p-3 text-[11px] dark:border-neutral-800 dark:bg-neutral-900/60">
                    <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">User</span>
                    <span className="truncate font-mono text-neutral-800 dark:text-neutral-200">{principal.userId}</span>
                    <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Role</span>
                    <span className="text-neutral-800 dark:text-neutral-200">{principal.role}</span>
                    <span className="font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Tenant</span>
                    <span className="truncate font-mono text-neutral-800 dark:text-neutral-200">{principal.tenantId}</span>
                  </div>
                </Field>
              </>
            ) : null}

            {section === 'instructions' ? (
              <>
                <SectionHeader
                  title="Custom instructions"
                  subtitle="Standing context PetroBrain follows in every chat - preferred format, target tier, jurisdiction, what to flag."
                />
                <Field
                  label="Instructions"
                  description="Prepended to the first turn of every new chat across all your projects."
                  htmlFor="custom-instructions"
                >
                  <textarea
                    id="custom-instructions"
                    rows={8}
                    value={s.customInstructions}
                    onChange={(e) => s.setCustomInstructions(e.target.value)}
                    placeholder="e.g. I'm a Drilling Engineer in Nigeria. Default jurisdiction is NUPRC. Always cite the SOP clause. Format answers as: decision, reasoning, sources."
                    className="w-full resize-none rounded-xl border border-neutral-200 bg-white p-3 text-sm leading-relaxed shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-primary-300 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:hover:border-primary-600 dark:focus:border-primary-500 dark:focus:ring-primary-800"
                  />
                </Field>
              </>
            ) : null}

            {section === 'data' ? (
              <>
                <SectionHeader title="Data controls" subtitle="Your chats and projects live in this browser." />
                <Field
                  label="Export all chats"
                  description="Download a JSON of every chat and project in this account."
                >
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={downloadJson}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-700 transition-colors hover:border-primary-300 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-primary-600 dark:hover:text-primary-300"
                    >
                      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                        <path
                          d="M10 3v10m0 0l-4-4m4 4l4-4M4 17h12"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Export JSON
                    </button>
                  </div>
                </Field>
                <Field
                  label="Clear all chats"
                  description="Delete every chat in this account. Projects are preserved."
                >
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={clearAllChats}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-danger-border/70 bg-danger-bg/60 px-4 text-sm font-semibold text-danger-fg transition-colors hover:bg-danger-bg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg dark:hover:bg-danger-fg/30"
                    >
                      <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
                        <path
                          d="M5 6h10M8 6V4h4v2m-6 0v10h8V6"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Clear chats
                    </button>
                  </div>
                </Field>
                <Field
                  label="Retention"
                  description="Chats and projects are stored in your browser's localStorage."
                >
                  <p className="rounded-xl border border-neutral-100 bg-neutral-50/60 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-400">
                    Clearing browser storage will remove your local chat history. PetroBrain does
                    not back this up server-side in the Tier-A console.
                  </p>
                </Field>
              </>
            ) : null}

            {section === 'notifications' ? (
              <>
                <SectionHeader title="Notifications" subtitle="Get pinged when long-running answers complete." />
                <Field
                  label="Browser notifications"
                  description="Notify me when an answer finishes streaming after I switch tabs."
                >
                  <div className="flex justify-end">
                    <Toggle
                      label="Enable notifications"
                      checked={s.enableNotifications}
                      onChange={s.setEnableNotifications}
                      disabled
                    />
                  </div>
                </Field>
                <StubBanner feature="Notifications" />
              </>
            ) : null}

            {section === 'spoken' ? (
              <>
                <SectionHeader title="Spoken language" subtitle="Voice input + dictation in the composer." />
                <StubBanner feature="Spoken language" />
              </>
            ) : null}

            {section === 'account' ? (
              <>
                <SectionHeader title="Account" subtitle="Backend endpoint and sign-out." />
                <Field
                  label="API base URL"
                  description="Where the chat surface posts to. Read-only - set via the host."
                >
                  <code className="block truncate rounded-xl border border-neutral-100 bg-neutral-50/60 px-3 py-2 text-xs text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200">
                    {apiBaseUrl}
                  </code>
                </Field>
                <Field
                  label="JWT preview"
                  description="Token last bytes - useful when diagnosing auth issues."
                >
                  <code className="block truncate rounded-xl border border-neutral-100 bg-neutral-50/60 px-3 py-2 text-xs text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-200">
                    …{(token ?? '').slice(-12)}
                  </code>
                </Field>
                <Field label="Sign out" description="Clears the JWT from this browser session.">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setToken(null)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-danger-border/70 bg-danger-bg/60 px-4 text-sm font-semibold text-danger-fg transition-colors hover:bg-danger-bg dark:border-danger-border/40 dark:bg-danger-fg/20 dark:text-danger-bg dark:hover:bg-danger-fg/30"
                    >
                      Sign out
                    </button>
                  </div>
                </Field>
                <Field
                  label="Reset preferences"
                  description="Restore every setting on this page to its default."
                >
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Reset all your settings to defaults?')) s.resetAll();
                      }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-700 transition-colors hover:border-primary-300 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-primary-600 dark:hover:text-primary-300"
                    >
                      Reset preferences
                    </button>
                  </div>
                </Field>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-2">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{subtitle}</p> : null}
    </header>
  );
}
