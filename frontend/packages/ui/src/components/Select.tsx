'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type SelectHTMLAttributes,
} from 'react';
import clsx from 'clsx';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'onChange'> {
  label: string;
  options: ReadonlyArray<SelectOption<T>>;
  hint?: string;
  error?: string;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
}

type SelectRef = HTMLSelectElement;

/**
 * Themed custom listbox styled to the PetroBrain brand.
 *
 * Renders a visible button + popover for design control, plus a visually
 * hidden native <select> so forms, autofill, and assistive tech keep
 * working. The onChange contract matches a native <select> change event
 * (e.target.value), so every existing call site keeps compiling.
 */
export const Select = forwardRef<SelectRef, SelectProps>(function Select(
  {
    label,
    options,
    hint,
    error,
    className,
    id,
    name,
    value,
    defaultValue,
    onChange,
    disabled,
    required,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? `pb-select-${autoId}`;
  const listboxId = `${selectId}-listbox`;

  const hiddenRef = useRef<HTMLSelectElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isControlled = value !== undefined;
  const initial =
    (isControlled ? (value as string) : (defaultValue as string | undefined)) ??
    (options[0]?.value ?? '');
  const [internal, setInternal] = useState<string>(initial);

  const current = isControlled ? (value as string) : internal;

  const selectedIndex = useMemo(() => {
    const idx = options.findIndex((o) => o.value === current);
    return idx === -1 ? 0 : idx;
  }, [options, current]);

  const selected = options[selectedIndex];

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(selectedIndex);

  useEffect(() => {
    if (open) setHighlighted(selectedIndex);
  }, [open, selectedIndex]);

  const commit = useCallback(
    (nextValue: string) => {
      if (!isControlled) setInternal(nextValue);
      const target = hiddenRef.current;
      if (target) {
        target.value = nextValue;
        if (onChange) {
          // Build a synthetic change event from the hidden <select> so
          // callers reading e.target.value get the native shape they expect.
          const event = {
            target,
            currentTarget: target,
            type: 'change',
            bubbles: true,
            cancelable: false,
            nativeEvent: new Event('change'),
            preventDefault: () => {},
            stopPropagation: () => {},
            isDefaultPrevented: () => false,
            isPropagationStopped: () => false,
            persist: () => {},
            timeStamp: Date.now(),
          } as unknown as ChangeEvent<HTMLSelectElement>;
          onChange(event);
        }
      }
    },
    [isControlled, onChange],
  );

  // Close popover on outside click / Escape.
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

  function onButtonKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + options.length) % options.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlighted(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlighted(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[highlighted];
      if (opt) {
        commit(opt.value);
        setOpen(false);
        buttonRef.current?.focus();
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className={clsx('flex flex-col gap-1.5', className)} ref={rootRef}>
      {label ? (
        <label
          htmlFor={selectId}
          className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
        >
          {label}
        </label>
      ) : null}

      <div className="relative">
        <button
          ref={buttonRef}
          id={selectId}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          {...(error ? { 'aria-invalid': 'true' as const } : {})}
          {...(disabled ? { 'aria-disabled': 'true' as const } : {})}
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={onButtonKeyDown}
          className={clsx(
            'group relative flex h-11 w-full items-center justify-between gap-2 rounded-xl border bg-white pl-3.5 pr-2.5 text-left text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100',
            'shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all',
            'hover:border-primary-300 hover:shadow-[0_2px_8px_rgba(234,88,12,0.10)] dark:hover:border-primary-600',
            'focus:outline-none focus-visible:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-200 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-800',
            disabled && 'cursor-not-allowed bg-neutral-50 opacity-60 hover:border-neutral-300 hover:shadow-none dark:bg-neutral-800',
            error
              ? 'border-danger-border focus-visible:ring-danger-border dark:border-danger-border/60'
              : 'border-neutral-200 dark:border-neutral-700',
            open && !error && 'border-primary-400 ring-2 ring-primary-200 dark:border-primary-500 dark:ring-primary-800',
          )}
        >
          <span className={clsx('truncate', !selected && 'text-neutral-400 dark:text-neutral-500')}>
            {selected?.label ?? '-'}
          </span>
          <span
            aria-hidden
            className={clsx(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 transition-transform dark:bg-primary-900/40 dark:text-primary-300',
              open && 'rotate-180',
            )}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
              <path
                d="M5 7.5L10 12.5L15 7.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        {open ? (
          <div
            ref={popoverRef}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-[70] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-[0_18px_40px_-12px_rgba(15,23,42,0.18),0_4px_10px_-2px_rgba(15,23,42,0.08)] focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
          >
            <ul
              id={listboxId}
              role="listbox"
              aria-labelledby={selectId}
              tabIndex={-1}
              className="max-h-64 overflow-auto py-1.5"
              autoFocus
            >
              {options.map((opt, idx) => {
                const isSelected = opt.value === current;
                const isHighlighted = idx === highlighted;
                return (
                  <li
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setHighlighted(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(opt.value);
                      setOpen(false);
                      buttonRef.current?.focus();
                    }}
                    className={clsx(
                      'mx-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                      isHighlighted
                        ? 'bg-primary-50 text-primary-800 dark:bg-primary-900/30 dark:text-primary-200'
                        : 'text-neutral-700 dark:text-neutral-200',
                      isSelected && !isHighlighted && 'text-primary-700 dark:text-primary-300',
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected ? (
                      <svg
                        aria-hidden
                        width="16"
                        height="16"
                        viewBox="0 0 20 20"
                        fill="none"
                        className="shrink-0 text-primary-600 dark:text-primary-400"
                      >
                        <path
                          d="M4 10.5L8 14.5L16 6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <select
          ref={(node) => {
            hiddenRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as { current: SelectRef | null }).current = node;
          }}
          name={name}
          value={current}
          required={required}
          disabled={disabled}
          tabIndex={-1}
          aria-hidden
          onChange={(e) => commit(e.target.value)}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {hint && !error ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-danger-fg dark:text-danger-bg">
          {error}
        </p>
      ) : null}
    </div>
  );
});
