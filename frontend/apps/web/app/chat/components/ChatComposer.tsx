'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@petrobrain/ui';

export interface ChatComposerProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function ChatComposer({ onSubmit, disabled }: ChatComposerProps) {
  const [value, setValue] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || disabled) return;
    onSubmit(value.trim());
    setValue('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends; plain Enter keeps newline so engineers can paste blocks of context.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit(e as unknown as FormEvent);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-neutral-200 bg-white p-4"
      aria-label="Ask PetroBrain"
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm transition focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-200">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          rows={2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a question grounded in your SOPs, or build a kill sheet…"
          className="flex-1 resize-none border-0 bg-transparent px-3 py-2 text-base focus:outline-none focus:ring-0"
          disabled={disabled}
        />
        <Button type="submit" variant="primary" size="md" disabled={!value.trim() || disabled}>
          Send
        </Button>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-neutral-400">
        PetroBrain is decision support — verify safety-critical numbers with the competent person. ⌘/Ctrl+Enter to send.
      </p>
    </form>
  );
}
