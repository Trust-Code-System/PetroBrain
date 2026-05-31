import type { HTMLAttributes } from 'react';
import clsx from 'clsx';

export type BadgeTone = 'neutral' | 'safe' | 'info' | 'warn' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:border-neutral-700',
  safe: 'bg-safe-bg text-safe-fg border-safe-border dark:bg-safe-fg/20 dark:text-safe-bg dark:border-safe-border/40',
  info: 'bg-info-bg text-info-fg border-info-border dark:bg-info-fg/20 dark:text-info-bg dark:border-info-border/40',
  warn: 'bg-warn-bg text-warn-fg border-warn-border dark:bg-warn-fg/20 dark:text-warn-bg dark:border-warn-border/40',
  danger: 'bg-danger-bg text-danger-fg border-danger-border dark:bg-danger-fg/20 dark:text-danger-bg dark:border-danger-border/40',
};

export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-pill border px-2 py-0.5 text-xs font-medium',
        toneClasses[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
