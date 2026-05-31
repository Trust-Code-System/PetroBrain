import type { HTMLAttributes } from 'react';
import clsx from 'clsx';
import type { ConfidenceLabel } from '@petrobrain/types';

export interface ConfidenceBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  label: ConfidenceLabel;
  reason?: string;
}

const labelClasses: Record<ConfidenceLabel, string> = {
  high: 'bg-safe-bg text-safe-fg border-safe-border dark:bg-safe-fg/20 dark:text-safe-bg dark:border-safe-border/40',
  medium: 'bg-info-bg text-info-fg border-info-border dark:bg-info-fg/20 dark:text-info-bg dark:border-info-border/40',
  low: 'bg-warn-bg text-warn-fg border-warn-border dark:bg-warn-fg/20 dark:text-warn-bg dark:border-warn-border/40',
  unknown: 'bg-neutral-100 text-neutral-700 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:border-neutral-700',
};

const labelText: Record<ConfidenceLabel, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  unknown: 'Confidence unknown',
};

/**
 * Confidence/uncertainty must be rendered visibly per the engineering spec -
 * never hidden inside a tooltip. Keep the label on the surface; the optional
 * ``reason`` shows on hover for engineers who want detail.
 */
export function ConfidenceBadge({ label, reason, className, ...rest }: ConfidenceBadgeProps) {
  return (
    <span
      title={reason ?? undefined}
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs font-medium',
        labelClasses[label],
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true">●</span>
      <span>{labelText[label]}</span>
    </span>
  );
}
