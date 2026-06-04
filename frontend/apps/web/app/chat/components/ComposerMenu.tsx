'use client';

import { useEffect, useRef, useState } from 'react';

import { SKILLS, type SkillEntry } from '@/lib/chat/catalog';
import { ownerKeyOf, useConversationsStore } from '@/lib/chat/conversations';
import { useProjectsStore } from '@/lib/chat/projects';
import { useChatStore } from '@/lib/chat/store';

type Panel = 'root' | 'skills' | 'project';

const CREATE_TASK_PROMPT = `Create a task from this chat.

Task:
Owner:
Priority:
Due date:
Context:
Acceptance criteria:
Next step:`;

const DEEP_RESEARCH_PROMPT = `Run deep research on this topic.

Research question:
Scope:
Sources to prioritize:
Assumptions to verify:
Deliverable format: executive summary, key findings, evidence, risks, and recommended next steps.`;

export interface ComposerMenuProps {
  onAttachFiles: () => void;
  onTakeScreenshot: () => Promise<void> | void;
  onApplyPrompt: (prompt: string) => void;
  disabled?: boolean | undefined;
}

export function ComposerMenu({
  onAttachFiles,
  onTakeScreenshot,
  onApplyPrompt,
  disabled,
}: ComposerMenuProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>('root');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const webSearchEnabled = useChatStore((s) => s.webSearchEnabled);
  const setWebSearchEnabled = useChatStore((s) => s.setWebSearchEnabled);
  const forceCanvasNext = useChatStore((s) => s.forceCanvasNext);
  const setForceCanvasNext = useChatStore((s) => s.setForceCanvasNext);
  const setThinkingMode = useChatStore((s) => s.setThinkingMode);
  const module = useChatStore((s) => s.module);
  const principal = useChatStore((s) => s.principal);

  const activeId = useConversationsStore((s) => s.activeId);
  const conversations = useConversationsStore((s) => s.conversations);
  const setConversationProject = useConversationsStore((s) => s.setConversationProject);

  const projects = useProjectsStore((s) => s.projects);
  const projectOrder = useProjectsStore((s) => s.order);
  const activeProjectId = useProjectsStore((s) => s.activeId);
  const selectProject = useProjectsStore((s) => s.selectProject);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPanel('root');
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        if (panel !== 'root') setPanel('root');
        else {
          setOpen(false);
          buttonRef.current?.focus();
        }
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, panel]);

  function close() {
    setOpen(false);
    setPanel('root');
    buttonRef.current?.focus();
  }

  function relevantSkills(): SkillEntry[] {
    // Pin skills that match the active module to the top, but keep the
    // others so the user can still pick "summarize SOP" while inside
    // emissions_mrv, etc.
    const matches = SKILLS.filter((s) => s.module === module || module === 'general');
    const rest = SKILLS.filter((s) => !matches.includes(s));
    return [...matches, ...rest];
  }

  const ownerKey = ownerKeyOf(principal);
  const myProjects = ownerKey
    ? projectOrder
        .map((id) => projects[id])
        .filter((p): p is NonNullable<typeof p> => Boolean(p && p.ownerKey === ownerKey))
    : [];

  const canMoveActiveConvo =
    Boolean(activeId)
    && Boolean(ownerKey)
    && conversations[activeId ?? '']?.ownerKey === ownerKey;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            setPanel('root');
          }
        }}
        disabled={disabled}
        title="Add files, skills, capabilities"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        aria-label="Open composer menu"
        className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
            : 'border-neutral-200/80 bg-white text-neutral-500 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-primary-600 dark:hover:bg-primary-900/30 dark:hover:text-primary-300'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {open ? (
        <div
          aria-label="Composer menu"
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-72 overflow-hidden rounded-2xl border border-neutral-200 bg-white py-1.5 shadow-[0_24px_48px_-16px_rgba(15,23,42,0.20),0_6px_12px_-4px_rgba(15,23,42,0.10)] dark:border-neutral-700 dark:bg-neutral-900"
        >
          {panel === 'root' ? (
            <>
              <Section title="Inputs">
                <Row
                  icon={<PaperclipIcon />}
                  label="Add files or photos"
                  shortcut="Ctrl+U"
                  onClick={() => {
                    onAttachFiles();
                    close();
                  }}
                />
                <Row
                  icon={<CameraIcon />}
                  label="Take a screenshot"
                  onClick={async () => {
                    close();
                    await onTakeScreenshot();
                  }}
                />
              </Section>

              <Divider />

              <Section title="Capabilities">
                <Row
                  icon={<TaskIcon />}
                  label="Task template"
                  hint="Inserts a fill-in-the-blanks brief"
                  onClick={() => {
                    onApplyPrompt(CREATE_TASK_PROMPT);
                    setForceCanvasNext(true);
                    close();
                  }}
                />
                <Row
                  icon={<ResearchIcon />}
                  label="Deep research mode"
                  hint="Web search + extended thinking + canvas"
                  onClick={() => {
                    setWebSearchEnabled(true);
                    setThinkingMode('extended');
                    setForceCanvasNext(true);
                    onApplyPrompt(DEEP_RESEARCH_PROMPT);
                    close();
                  }}
                />
                <Row
                  icon={<SkillsIcon />}
                  label="Skills..."
                  trailing={<ChevronRight />}
                  onClick={() => setPanel('skills')}
                />
                <Row
                  icon={<ProjectIcon />}
                  label="Add to project..."
                  trailing={<ChevronRight />}
                  onClick={() => setPanel('project')}
                  disabled={!canMoveActiveConvo || myProjects.length === 0}
                  hint={
                    !canMoveActiveConvo
                      ? 'Send a message first to create a chat'
                      : myProjects.length === 0
                        ? 'No projects yet - create one from the sidebar'
                        : null
                  }
                />
              </Section>

              <Divider />

              <Section title="For this turn">
                <ToggleRow
                  icon={<GlobeIcon />}
                  label="Web search"
                  hint={webSearchEnabled ? 'On - Tavily available' : 'Off - tenant docs only'}
                  checked={webSearchEnabled}
                  onChange={() => setWebSearchEnabled(!webSearchEnabled)}
                />
                <ToggleRow
                  icon={<CanvasIcon />}
                  label="Open in canvas"
                  hint={
                    forceCanvasNext
                      ? 'Will open the next reply in canvas'
                      : 'Off - canvas only opens on long replies'
                  }
                  checked={forceCanvasNext}
                  onChange={() => setForceCanvasNext(!forceCanvasNext)}
                />
              </Section>
            </>
          ) : null}

          {panel === 'skills' ? (
            <>
              <SubHeader label="Skills" onBack={() => setPanel('root')} />
              <ul className="max-h-80 overflow-y-auto py-1">
                {relevantSkills().map((s) => (
                  <li key={s.slug}>
                    <button
                      type="button"
                      onClick={() => {
                        onApplyPrompt(s.prompt);
                        close();
                      }}
                      className="block w-full px-3 py-2 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                          {s.name}
                        </span>
                        <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          {s.module.replace('_', ' ')}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                        {s.description}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {panel === 'project' ? (
            <>
              <SubHeader label="Add to project" onBack={() => setPanel('root')} />
              <ul className="max-h-80 overflow-y-auto py-1">
                {myProjects.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                    No projects yet. Create one from the sidebar.
                  </li>
                ) : null}
                {myProjects.map((p) => {
                  const selected = activeProjectId === p.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (!ownerKey || !activeId) return;
                          setConversationProject(activeId, p.id);
                          selectProject(p.id);
                          close();
                        }}
                        disabled={!canMoveActiveConvo}
                        className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected
                            ? 'bg-primary-50/70 dark:bg-primary-900/30'
                            : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60'
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            selected
                              ? 'border-primary-500 bg-primary-500 text-white'
                              : 'border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-800'
                          }`}
                        >
                          {selected ? (
                            <svg width="9" height="9" viewBox="0 0 20 20" fill="none">
                              <path
                                d="M5 10.5L8.5 14L15 7"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : null}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                            {p.name}
                          </p>
                          {p.description ? (
                            <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                              {p.description}
                            </p>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-0.5">
      <p className="px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-neutral-400 dark:text-neutral-500">
        {title}
      </p>
      <ul>{children}</ul>
    </div>
  );
}

function SubHeader({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-neutral-100 px-2 py-2 dark:border-neutral-800">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
          <path d="M12 5l-5 5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">{label}</span>
    </div>
  );
}

function Divider() {
  return <div className="my-0.5 h-px bg-neutral-100 dark:bg-neutral-800" />;
}

function Row({
  icon,
  label,
  shortcut,
  trailing,
  onClick,
  disabled,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  trailing?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  hint?: string | null;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={hint || undefined}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-neutral-800 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-100 dark:hover:bg-neutral-800/60"
      >
        <span className="text-neutral-500 dark:text-neutral-400">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {shortcut ? (
          <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {shortcut}
          </span>
        ) : null}
        {trailing}
      </button>
    </li>
  );
}

function ToggleRow({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={checked ? 'true' : 'false'}
        onClick={onChange}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
      >
        <span className="text-neutral-500 dark:text-neutral-400">{icon}</span>
        <span className="flex-1">
          <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-100">{label}</span>
          {hint ? (
            <span className="block text-[10px] text-neutral-500 dark:text-neutral-400">{hint}</span>
          ) : null}
        </span>
        <span
          className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${
            checked ? 'bg-primary-500' : 'bg-neutral-300 dark:bg-neutral-700'
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${
              checked ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </span>
      </button>
    </li>
  );
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M14.5 9.5l-5.6 5.6a3.5 3.5 0 01-5-5l6.6-6.6a2.3 2.3 0 113.3 3.3L7.5 13.5a1.2 1.2 0 11-1.7-1.7l5.4-5.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M4 7h2.5l1.5-2h4l1.5 2H16a1 1 0 011 1v7a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="11" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M5 3h10a1 1 0 011 1v13l-3-2-3 2-3-2-3 2V4a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7 7h6M7 10h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TaskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M8 5h8M8 10h8M8 15h8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M3.5 5.2l.9.9 1.8-2M3.5 10.2l.9.9 1.8-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4.7" cy="15" r="1.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ResearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M4 12.5l3-1 5.5-5.5 1.5 1.5L8.5 13l-1 3-3.5-3.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 6L14 4.5a1.4 1.4 0 012 2L14.5 8M3 5.5l3.5-1M4 3l1 3.5M14 14l3 3M15.5 12.5l2 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProjectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M3 10h14M10 3a10 10 0 010 14M10 3a10 10 0 000 14"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CanvasIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M4 5.5A1.5 1.5 0 015.5 4h9A1.5 1.5 0 0116 5.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 14.5v-9z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M11 4v12M11 9h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 20 20" fill="none" aria-hidden className="text-neutral-400">
      <path d="M8 5l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
