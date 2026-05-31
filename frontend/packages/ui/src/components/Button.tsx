import { forwardRef, type ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: [
    'relative isolate text-white',
    'bg-gradient-to-b from-primary-500 to-primary-700',
    'shadow-brand-primary shadow-inner-soft',
    'hover:from-primary-400 hover:to-primary-600 hover:shadow-brand-primary-lg',
    'active:from-primary-600 active:to-primary-700 active:translate-y-px',
    'focus-visible:ring-primary-300',
    "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-[inherit] before:bg-gradient-to-b before:from-white/25 before:to-transparent before:content-['']",
  ].join(' '),
  secondary: [
    'bg-white text-primary-700 border border-primary-200',
    'shadow-brand-sm',
    'hover:bg-primary-50 hover:border-primary-300 hover:shadow-brand-md',
    'active:translate-y-px',
    'focus-visible:ring-primary-300',
    'dark:bg-neutral-900 dark:text-primary-300 dark:border-primary-700/40',
    'dark:hover:bg-primary-900/30 dark:hover:border-primary-600',
  ].join(' '),
  ghost: [
    'bg-transparent text-primary-700',
    'hover:bg-primary-50',
    'focus-visible:ring-primary-300',
    'dark:text-primary-300 dark:hover:bg-primary-900/30',
  ].join(' '),
  danger: [
    'text-white',
    'bg-gradient-to-b from-[#d4373b] to-[#9a1d20]',
    'shadow-[0_10px_24px_-8px_rgba(184,38,42,0.45)] shadow-inner-soft',
    'hover:from-[#dc4145] hover:to-[#8a181b]',
    'active:translate-y-px',
    'focus-visible:ring-[#d4373b]',
  ].join(' '),
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-sm rounded-lg',
  md: 'h-11 px-5 text-sm rounded-xl',
  lg: 'h-14 px-7 text-base rounded-2xl min-h-tap',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, className, disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-semibold tracking-tight',
        'transition-all duration-150 ease-out',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-950',
        'disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <svg
          aria-hidden
          className="h-4 w-4 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
      <span className="relative">{children}</span>
    </button>
  );
});
