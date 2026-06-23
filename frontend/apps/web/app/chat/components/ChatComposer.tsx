'use client';

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import type { MessageAttachment } from '@/lib/chat/types';
import { usePendingPromptStore } from '@/lib/chat/pendingPrompt';
import { useSettingsStore } from '@/lib/chat/settings';
import { useChatStore, type ThinkingMode } from '@/lib/chat/store';

import { ComposerMenu } from './ComposerMenu';

// Picker copy is deliberately behaviour-focused, not model-named. Users
// don't need to know which underlying provider/model powers each tier and
// surfacing those names ('Haiku', 'Sonnet') leaked an implementation
// detail that doesn't survive a future provider swap.
const THINKING_MODES: Array<{ key: ThinkingMode; label: string; title: string }> = [
  { key: 'instant', label: 'Instant', title: 'Fast answers for quick questions' },
  { key: 'default', label: 'Default', title: 'Standard answers - balanced speed and depth' },
  { key: 'extended', label: 'Extended', title: 'Deeper thinking for hard or multi-step problems' },
];

const ACCEPTED = '.txt,.md,.markdown,.csv,.json,.pdf,.docx,image/*';
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per file
const MAX_FILES = 6;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  abort: () => void;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function combineVoiceText(base: string, transcript: string): string {
  const spoken = transcript.trimStart();
  if (!spoken) return base;
  if (!base.trim()) return spoken;
  const separator = /[\s\n]$/.test(base) ? '' : ' ';
  return `${base}${separator}${spoken}`;
}

export interface ChatComposerProps {
  onSubmit: (text: string, attachments: MessageAttachment[]) => void;
  /** Hard-disabled (no auth / no backend). Distinct from ``sending`` so the user
   *  can keep typing the next prompt while an answer is streaming. */
  disabled?: boolean;
  /** True while an assistant turn is streaming. Swaps the send button for a
   *  Stop button that calls ``onStop`` to abort the in-flight fetch. */
  sending?: boolean;
  onStop?: () => void;
}

let attachCounter = 0;
function nextAttachId(): string {
  attachCounter += 1;
  return `att-${Date.now()}-${attachCounter}`;
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function classifyKind(file: File): MessageAttachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (['txt', 'md', 'markdown', 'csv', 'json'].includes(ext)) return 'text';
  return 'document';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ThinkingModePicker({
  value,
  onChange,
  disabled,
}: {
  value: ThinkingMode;
  onChange: (m: ThinkingMode) => void;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const current = THINKING_MODES.find((m) => m.key === value) ?? THINKING_MODES[1]!;

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-0.5 mr-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        title={current.title}
        className={`group inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-900 ${
          open
            ? 'border-primary-300 text-primary-700 dark:border-primary-600 dark:text-primary-300'
            : 'border-neutral-200/80 text-neutral-700 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-primary-600 dark:hover:bg-primary-900/30 dark:hover:text-primary-300'
        }`}
      >
        <span>{current.label}</span>
        <svg
          aria-hidden
          width="10"
          height="10"
          viewBox="0 0 20 20"
          fill="none"
          className={`text-neutral-500 transition-transform dark:text-neutral-400 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <ul
          aria-label="Thinking mode"
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-56 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-[0_18px_36px_-12px_rgba(15,23,42,0.20),0_4px_10px_-3px_rgba(15,23,42,0.10)] dark:border-neutral-700 dark:bg-neutral-900"
        >
          {THINKING_MODES.map((m) => {
            const selected = m.key === value;
            return (
              <li key={m.key}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m.key);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                  className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? 'bg-primary-50/70 dark:bg-primary-900/30'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                      selected
                        ? 'border-primary-500 bg-primary-500 text-white'
                        : 'border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-800'
                    }`}
                  >
                    {selected ? (
                      <svg width="8" height="8" viewBox="0 0 20 20" fill="none">
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
                    <p
                      className={`text-xs font-semibold ${
                        selected
                          ? 'text-primary-800 dark:text-primary-200'
                          : 'text-neutral-900 dark:text-neutral-100'
                      }`}
                    >
                      {m.label}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                      {m.title}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function ChatComposer({ onSubmit, disabled, sending, onStop }: ChatComposerProps) {
  const thinkingMode = useChatStore((s) => s.thinkingMode);
  const setThinkingMode = useChatStore((s) => s.setThinkingMode);
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceBaseRef = useRef('');

  // Drain any pending prompt the user picked from the Customize directory.
  // Runs once on mount and clears the store so refresh doesn't replay it.
  const consumePending = usePendingPromptStore((s) => s.consume);
  useEffect(() => {
    const next = consumePending();
    if (next) {
      setValue(next);
      window.setTimeout(() => {
        textareaRef.current?.focus();
        const el = textareaRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+U opens the file picker (matches the shortcut shown in the +menu row).
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        fileInputRef.current?.click();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? '';
        if (result?.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      setValue(combineVoiceText(voiceBaseRef.current, `${finalText}${interimText}`));
    };
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Microphone access was blocked.');
      } else if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        setError('Voice input stopped. Try again when you are ready.');
      }
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setVoiceSupported(true);

    return () => {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, []);

  // Browser screen capture into the attachments tray. User picks a screen,
  // window, or tab; we grab one frame, encode it as PNG, drop it in as an
  // image attachment, then release the stream.
  async function takeScreenshot() {
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      setError('Screen capture not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('No video track');
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1920;
      canvas.height = video.videoHeight || 1080;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D unavailable');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      track.stop();
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not encode screenshot');
      const filename = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      const file = new File([blob], filename, { type: 'image/png' });
      await addFiles([file]);
    } catch (err) {
      if ((err as { name?: string }).name === 'NotAllowedError') return; // user dismissed
      setError(err instanceof Error ? err.message : 'Could not capture screenshot.');
    }
  }

  // Auto-grow the textarea up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const incoming = Array.from(files);
    if (attachments.length + incoming.length > MAX_FILES) {
      setError(`Maximum ${MAX_FILES} attachments per message.`);
      return;
    }

    const next: MessageAttachment[] = [];
    for (const file of incoming) {
      if (file.size > MAX_BYTES) {
        setError(`${file.name} is over the ${formatBytes(MAX_BYTES)} limit.`);
        continue;
      }
      const kind = classifyKind(file);
      let preview: string | null = null;
      try {
        if (kind === 'image') preview = await readAsDataURL(file);
        else if (kind === 'text') preview = await readAsText(file);
        else if (kind === 'document') {
          // PDFs / DOCX: read the bytes as base64 so the orchestrator can
          // extract text in-process with pdfplumber / python-docx. Without
          // this, the model only sees the filename and replies "I can't read
          // the file".
          preview = await readAsDataURL(file);
        }
      } catch {
        // Don't drop the whole batch on one read failure - just attach a stub.
        preview = null;
      }
      next.push({
        id: nextAttachId(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        kind,
        preview,
      });
    }
    setAttachments((curr) => [...curr, ...next]);
  }

  function removeAttachment(id: string) {
    setAttachments((curr) => curr.filter((a) => a.id !== id));
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      void addFiles(e.target.files);
      e.target.value = '';
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.currentTarget === e.target) setDragOver(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    // Block submit while another turn is streaming so the user's draft isn't
    // silently cleared and the parent's send() no-op isn't surprising.
    if ((!trimmed && attachments.length === 0) || disabled || sending) return;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
    }
    onSubmit(trimmed, attachments);
    setValue('');
    setAttachments([]);
    setError(null);
  }

  // Send behavior follows the user's setting:
  //   'enter'        → Enter sends, Shift+Enter newline (default - like ChatGPT/Claude)
  //   'shift_enter'  → Shift+Enter sends, plain Enter newline
  const sendShortcut = useSettingsStore((s) => s.sendShortcut);
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== 'Enter') return;
    const shouldSend =
      sendShortcut === 'enter' ? !e.shiftKey : e.shiftKey;
    if (shouldSend) {
      e.preventDefault();
      submit(e as unknown as FormEvent);
    }
  }

  /**
   * Accept pasted images (e.g. screenshots from the system snipping tool).
   * Browsers expose clipboard images via ``clipboardData.items``; each item
   * that is a file gets routed through the normal addFiles() path so it
   * picks up the same size limits, MIME inspection, and upload counter as a
   * dragged or picked file. We only call preventDefault when there's at
   * least one file item, so a plain-text paste still lands in the textarea.
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      // Screenshots arrive as "image.png" or just "" - give them a clearer
      // name so the chip / audit log isn't ambiguous later.
      const named =
        file.name && file.name !== 'image.png'
          ? file
          : new File([file], `pasted-${Date.now()}.png`, { type: file.type || 'image/png' });
      files.push(named);
    }
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function applyAction(prompt: string) {
    setValue((v) => (v ? `${v}\n\n${prompt}` : prompt));
    textareaRef.current?.focus();
  }

  function toggleVoiceInput() {
    const recognition = recognitionRef.current;
    if (!recognition || disabled || sending) return;
    setError(null);
    if (listening) {
      recognition.stop();
      setListening(false);
      return;
    }
    voiceBaseRef.current = value;
    try {
      recognition.start();
      setListening(true);
      textareaRef.current?.focus();
    } catch {
      setListening(false);
      setError('Voice input could not start. Try again in a moment.');
    }
  }

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <form
      onSubmit={submit}
      className="safe-composer relative z-10 bg-transparent px-3 pt-3 sm:px-4"
      aria-label="Ask PetroBrain"
    >
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border bg-white p-2 shadow-[0_4px_16px_-6px_rgba(15,23,42,0.10),0_1px_2px_rgba(15,23,42,0.04)] transition-all focus-within:border-primary-400 focus-within:shadow-[0_10px_28px_-10px_rgba(234,88,12,0.30),0_2px_4px_rgba(15,23,42,0.05)] focus-within:ring-2 focus-within:ring-primary-200 dark:bg-neutral-900 dark:focus-within:border-primary-500 dark:focus-within:ring-primary-800 ${
          dragOver
            ? 'border-primary-400 bg-primary-50/40 ring-2 ring-primary-200 dark:bg-primary-900/20 dark:ring-primary-700'
            : 'border-neutral-200 dark:border-neutral-700'
        }`}
      >
        {attachments.length > 0 ? (
          <ul className="flex flex-wrap gap-2 px-1 pt-1" aria-label="Attached files">
            {attachments.map((a) => (
              <li
                key={a.id}
                className="group relative flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50/60 py-1 pl-1 pr-2 dark:border-neutral-700 dark:bg-neutral-800/60"
              >
                {a.kind === 'image' && a.preview ? (
                  <img
                    src={a.preview}
                    alt={a.name}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                ) : (
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                      a.kind === 'text'
                        ? 'bg-gradient-to-br from-primary-50 to-primary-100 text-primary-600 dark:from-primary-900/40 dark:to-primary-800/40 dark:text-primary-300'
                        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                    }`}
                    aria-hidden
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
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
                <div className="flex max-w-[12rem] flex-col leading-tight">
                  <span className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-200" title={a.name}>
                    {a.name}
                  </span>
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
                    {formatBytes(a.sizeBytes)}
                    {a.kind === 'document' ? ' · use Documents tab to ingest' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-500 opacity-0 shadow-sm transition-opacity hover:bg-neutral-100 hover:text-neutral-700 group-hover:opacity-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
                    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id="chat-input"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Ask a question grounded in your SOPs, or build a kill sheet…"
          // text-base (16px) is deliberate: iOS Safari zooms the page when a
          // focused input is under 16px, which is the classic mobile chat jank.
          className="scrollbar-hide max-h-40 min-h-[28px] resize-none border-0 bg-transparent px-2.5 py-1.5 text-base leading-relaxed text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-0 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          disabled={disabled}
        />

        <div className="flex items-center justify-between gap-2 pl-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED}
              onChange={onFileInputChange}
              className="sr-only"
              aria-label="Attach files"
            />
            <ComposerMenu
              onAttachFiles={() => fileInputRef.current?.click()}
              onTakeScreenshot={takeScreenshot}
              onApplyPrompt={applyAction}
              disabled={disabled}
            />
            <ThinkingModePicker
              value={thinkingMode}
              onChange={setThinkingMode}
              disabled={disabled}
            />
            {voiceSupported ? (
              <button
                type="button"
                onClick={toggleVoiceInput}
                disabled={disabled || sending}
                aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                title={listening ? 'Stop voice input' : 'Start voice input'}
                className={`inline-flex h-9 w-9 items-center justify-center rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:w-8 ${
                  listening
                    ? 'border-primary-300 bg-primary-50 text-primary-700 shadow-[0_0_0_3px_rgba(234,88,12,0.12)] dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-200'
                    : 'border-neutral-200/80 bg-white text-neutral-600 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-primary-900/30 dark:hover:text-primary-300'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path
                    d="M10 12.5a3 3 0 003-3v-4a3 3 0 00-6 0v4a3 3 0 003 3z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5M7.5 17.5h5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : null}
          </div>

          {sending ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="group relative isolate flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-neutral-800 to-neutral-900 text-white sm:h-9 sm:w-9 shadow-[0_6px_14px_-6px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.18)] transition-all hover:from-neutral-700 hover:to-neutral-800 dark:from-neutral-200 dark:to-neutral-100 dark:text-neutral-900 dark:hover:from-neutral-100 dark:hover:to-white"
            >
              <span aria-hidden className="block h-3 w-3 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              className="group relative isolate flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-primary-500 to-primary-700 text-white sm:h-9 sm:w-9 shadow-[0_6px_14px_-6px_rgba(234,88,12,0.55),inset_0_1px_0_rgba(255,255,255,0.28)] transition-all hover:from-primary-400 hover:to-primary-600 hover:shadow-[0_10px_24px_-8px_rgba(234,88,12,0.55)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-[0_6px_14px_-6px_rgba(234,88,12,0.55),inset_0_1px_0_rgba(255,255,255,0.28)]"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M10 16V4M4 10l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-danger-fg dark:text-danger-bg">
          {error}
        </p>
      ) : null}

      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-neutral-400 dark:text-neutral-500">
        PetroBrain is decision support - verify safety-critical numbers with the competent person.{' '}
        {sendShortcut === 'enter'
          ? 'Enter to send · Shift+Enter for newline.'
          : 'Shift+Enter to send · Enter for newline.'}
      </p>
    </form>
  );
}
