'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

const OTHER_SENTINEL = '__other__';

interface ComboboxProps {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  /** Adds an "Other" entry; selecting it reveals a free-text input. */
  allowOther?: boolean;
  otherLabel?: string;
  otherPlaceholder?: string;
  formatOption?: (value: string) => string;
  hint?: string;
}

/**
 * Themed, brand-styled dropdown used across the app.
 *
 * Replaces the native <select> with a custom listbox so the picker matches
 * the PetroBrain color scheme, supports type-ahead search for long lists
 * (countries, timezones), and offers an "Other" escape hatch that reveals a
 * free-text field for values not in the list.
 */
export function Combobox({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select',
  searchable = false,
  allowOther = false,
  otherLabel = 'Other (type your own)',
  otherPlaceholder = 'Type your answer',
  formatOption = (v) => v,
  hint,
}: ComboboxProps) {
  const autoId = useId();
  const listboxId = `${autoId}-listbox`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const otherInputRef = useRef<HTMLInputElement | null>(null);

  // A non-empty value that is not one of the known options is a previously
  // saved free-text ("Other") answer, so start in custom mode for it.
  const valueIsKnown = options.includes(value);
  const [manualOther, setManualOther] = useState(false);
  const customMode = allowOther && (manualOther || (value !== '' && !valueIsKnown));

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);

  // Build the option list shown in the popover: known options (minus any
  // literal "Other" we replace with our sentinel) plus the Other sentinel.
  const listOptions = useMemo(() => {
    const base = allowOther
      ? options.filter((option) => option.toLowerCase() !== 'other')
      : options;
    const mapped = base.map((option) => ({ value: option, label: formatOption(option) }));
    if (allowOther) mapped.push({ value: OTHER_SENTINEL, label: otherLabel });
    return mapped;
  }, [options, allowOther, otherLabel, formatOption]);

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return listOptions;
    const needle = query.trim().toLowerCase();
    return listOptions.filter((option) => option.label.toLowerCase().includes(needle));
  }, [listOptions, query, searchable]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlighted(0);
    const focusTimer = window.setTimeout(() => {
      if (searchable) searchRef.current?.focus();
    }, 0);
    function onPointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, searchable]);

  function choose(optionValue: string) {
    if (optionValue === OTHER_SENTINEL) {
      setManualOther(true);
      onChange('');
      setOpen(false);
      window.setTimeout(() => otherInputRef.current?.focus(), 0);
      return;
    }
    setManualOther(false);
    onChange(optionValue);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = filtered[highlighted];
      if (option) choose(option.value);
    }
  }

  const buttonLabel = customMode ? otherLabel : value ? formatOption(value) : placeholder;
  const showPlaceholder = !customMode && !value;

  return (
    <div className="flex flex-col gap-1.5" ref={rootRef}>
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
        {label}
      </span>

      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          onClick={() => setOpen((isOpen) => !isOpen)}
          className={clsx(
            'group relative flex h-11 w-full items-center justify-between gap-2 rounded-xl border bg-white pl-3.5 pr-2.5 text-left text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100',
            'shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all',
            'hover:border-primary-300 hover:shadow-[0_2px_8px_rgba(234,88,12,0.10)] dark:hover:border-primary-600',
            'focus:outline-none focus-visible:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-200 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-800',
            open
              ? 'border-primary-400 ring-2 ring-primary-200 dark:border-primary-500 dark:ring-primary-800'
              : 'border-neutral-200 dark:border-neutral-700',
          )}
        >
          <span className={clsx('truncate', showPlaceholder && 'text-neutral-400 dark:text-neutral-500')}>
            {buttonLabel}
          </span>
          <span
            aria-hidden
            className={clsx(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 transition-transform dark:bg-primary-900/40 dark:text-primary-300',
              open && 'rotate-180',
            )}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
              <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {open ? (
          <div
            onKeyDown={onListKeyDown}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-[70] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-[0_18px_40px_-12px_rgba(15,23,42,0.18),0_4px_10px_-2px_rgba(15,23,42,0.08)] dark:border-neutral-700 dark:bg-neutral-900"
          >
            {searchable ? (
              <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlighted(0);
                  }}
                  placeholder="Search..."
                  className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-primary-500 dark:focus:ring-primary-800"
                />
              </div>
            ) : null}
            <ul id={listboxId} role="listbox" className="max-h-64 overflow-auto py-1.5">
              {filtered.length === 0 ? (
                <li className="px-4 py-2 text-sm text-neutral-400 dark:text-neutral-500">No matches</li>
              ) : (
                filtered.map((option, index) => {
                  const isSelected = customMode
                    ? option.value === OTHER_SENTINEL
                    : option.value === value;
                  const isHighlighted = index === highlighted;
                  return (
                    <li
                      key={option.value}
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setHighlighted(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        choose(option.value);
                      }}
                      className={clsx(
                        'mx-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                        isHighlighted
                          ? 'bg-primary-50 text-primary-800 dark:bg-primary-900/30 dark:text-primary-200'
                          : 'text-neutral-700 dark:text-neutral-200',
                        isSelected && !isHighlighted && 'text-primary-700 dark:text-primary-300',
                      )}
                    >
                      <span className="truncate">{option.label}</span>
                      {isSelected ? (
                        <svg aria-hidden width="16" height="16" viewBox="0 0 20 20" fill="none" className="shrink-0 text-primary-600 dark:text-primary-400">
                          <path d="M4 10.5L8 14.5L16 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        ) : null}
      </div>

      {customMode ? (
        <input
          ref={otherInputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={otherPlaceholder}
          className="mt-1 h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-primary-500 dark:focus:ring-primary-800"
        />
      ) : null}

      {hint ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
    </div>
  );
}
