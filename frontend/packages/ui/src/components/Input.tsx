import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import clsx from 'clsx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  unit?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, unit, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy =
    [error ? `${inputId}-error` : null, hint ? `${inputId}-hint` : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300"
      >
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={clsx(
            'h-11 w-full rounded-xl border bg-white px-3.5 text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100',
            'shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all',
            'placeholder:text-neutral-400 dark:placeholder:text-neutral-500',
            'hover:border-primary-300 hover:shadow-[0_2px_8px_rgba(234,88,12,0.10)] dark:hover:border-primary-600',
            'focus:outline-none focus-visible:border-primary-400 focus-visible:ring-2 focus-visible:ring-primary-200 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-800',
            'disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:opacity-60 dark:disabled:bg-neutral-800',
            error
              ? 'border-danger-border focus-visible:ring-danger-border dark:border-danger-border/60'
              : 'border-neutral-200 dark:border-neutral-700',
            unit && 'pr-12',
            className,
          )}
          {...rest}
        />
        {unit ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-primary-50 px-1.5 py-0.5 text-xs font-medium text-primary-700 dark:bg-primary-900/40 dark:text-primary-300">
            {unit}
          </span>
        ) : null}
      </div>
      {hint && !error ? (
        <p id={`${inputId}-hint`} className="text-xs text-neutral-500 dark:text-neutral-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-danger-fg dark:text-danger-bg">
          {error}
        </p>
      ) : null}
    </div>
  );
});
