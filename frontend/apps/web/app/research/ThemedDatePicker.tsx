'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

interface ThemedDatePickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  align?: 'left' | 'right';
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function ThemedDatePicker({
  label,
  value,
  onChange,
  align = 'left',
}: ThemedDatePickerProps) {
  const triggerId = useId();
  const labelId = `${triggerId}-label`;
  const valueId = `${triggerId}-value`;
  const selected = parseDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(
    startOfMonth(selected ?? new Date()),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (selected) setVisibleMonth(startOfMonth(selected));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const todayKey = toDateKey(new Date());

  function selectDate(day: Date) {
    onChange(toDateKey(day));
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={rootRef} className="relative flex flex-col gap-1.5">
      <label
        id={labelId}
        htmlFor={triggerId}
        className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
      >
        {label}
      </label>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => setOpen((current) => !current)}
        className={clsx(
          'flex h-11 w-full items-center justify-between gap-2 rounded-xl border bg-white px-3 text-left text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all dark:bg-neutral-900',
          'hover:border-primary-300 hover:shadow-[0_2px_8px_rgba(234,88,12,0.10)] dark:hover:border-primary-600',
          'focus-visible:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-200 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-800',
          open
            ? 'border-primary-400 ring-2 ring-primary-200 dark:border-primary-500 dark:ring-primary-800'
            : 'border-neutral-200 dark:border-neutral-700',
        )}
      >
        <span
          id={valueId}
          className={value ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-400'}
        >
          {selected ? formatDisplayDate(selected) : 'dd/mm/yyyy'}
        </span>
        <CalendarIcon />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={`${label} calendar`}
          className={clsx(
            'absolute top-[calc(100%+6px)] z-[80] w-72 rounded-2xl border border-neutral-200 bg-white p-3 shadow-[0_20px_50px_-16px_rgba(67,20,7,0.28)] dark:border-neutral-700 dark:bg-neutral-900',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
              className={calendarNavClass}
            >
              <Chevron direction="left" />
            </button>
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {visibleMonth.toLocaleDateString('en-GB', {
                month: 'long',
                year: 'numeric',
              })}
            </p>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
              className={calendarNavClass}
            >
              <Chevron direction="right" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((weekday) => (
              <span
                key={weekday}
                className="grid h-8 place-items-center text-[10px] font-semibold uppercase text-neutral-400"
              >
                {weekday}
              </span>
            ))}
            {days.map((day) => {
              const key = toDateKey(day);
              const selectedDay = key === value;
              const today = key === todayKey;
              const outsideMonth = day.getMonth() !== visibleMonth.getMonth();
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={day.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                  aria-pressed={selectedDay}
                  onClick={() => selectDate(day)}
                  className={clsx(
                    'grid h-8 place-items-center rounded-lg text-xs font-medium transition-colors',
                    selectedDay
                      ? 'bg-primary-600 text-white shadow-brand-primary'
                      : 'text-neutral-700 hover:bg-primary-50 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-primary-900/30 dark:hover:text-primary-200',
                    outsideMonth && !selectedDay && 'text-neutral-300 dark:text-neutral-600',
                    today && !selectedDay && 'ring-1 ring-inset ring-primary-300 text-primary-700 dark:text-primary-300',
                  )}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-neutral-100 pt-3 dark:border-neutral-800">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="text-xs font-semibold text-neutral-500 hover:text-primary-700 dark:hover:text-primary-300"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => selectDate(new Date())}
              className="rounded-full bg-primary-50 px-3 py-1.5 text-xs font-semibold text-primary-700 hover:bg-primary-100 dark:bg-primary-900/30 dark:text-primary-300"
            >
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function calendarDays(month: Date): Date[] {
  const first = startOfMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  return Array.from(
    { length: 42 },
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB').format(date);
}

function CalendarIcon() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-900/40 dark:text-primary-300">
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="3" y="4.5" width="14" height="12.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 8h14M6.5 2.5v4M13.5 2.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d={direction === 'left' ? 'M12.5 5L7.5 10l5 5' : 'M7.5 5l5 5-5 5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const calendarNavClass =
  'grid h-8 w-8 place-items-center rounded-full border border-neutral-200 text-neutral-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-primary-600 dark:hover:bg-primary-900/30';
