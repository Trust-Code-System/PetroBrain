import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';
import type { Citation } from '@petrobrain/types';

type ChipBaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export interface CitationChipProps extends ChipBaseProps {
  citation: Citation;
}

const CHIP_CLASSES = [
  'inline-flex items-center gap-1 rounded-pill border border-primary-200 bg-primary-50 dark:border-primary-700/40 dark:bg-primary-900/30',
  'px-2 py-0.5 text-xs font-medium text-primary-700 hover:bg-primary-100 dark:text-primary-200 dark:hover:bg-primary-900/50',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400',
];

/**
 * Compact, click-to-open citation reference.
 *
 * When the citation carries a ``url`` (web-sourced via Tavily) the chip is an
 * external link; otherwise it stays a button so the surrounding surface can
 * intercept clicks for in-app document navigation.
 *
 * On safety-critical answers the parent surface must NOT hide the chip
 * behind a click; render it inline next to the sentence it supports.
 */
export function CitationChip({ citation, className, ...rest }: CitationChipProps) {
  const label = formatLabel(citation);
  const url = citation.url ?? null;

  if (url) {
    // Strip the button-shaped event handlers (onClick, etc.) the parent passed
    // - an anchor handles navigation natively and we don't want a misplaced
    // listener silently swallowing the link click.
    const anchorRest = rest as Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'>;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        aria-label={`Open citation source: ${label}`}
        className={clsx(...CHIP_CLASSES, 'underline-offset-2 hover:underline', className)}
        {...anchorRest}
      >
        <span aria-hidden="true">🌐</span>
        <span>{label}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      title={label}
      aria-label={`Citation: ${label}`}
      className={clsx(...CHIP_CLASSES, className)}
      {...rest}
    >
      <span aria-hidden="true">📑</span>
      <span>{label}</span>
    </button>
  );
}

function formatLabel(c: Citation): string {
  const parts: string[] = [];
  if (c.title) parts.push(c.title);
  if (c.revision) parts.push(c.revision);
  if (c.clause) parts.push(`§${c.clause}`);
  if (parts.length === 0 && c.url) {
    try {
      return new URL(c.url).hostname.replace(/^www\./, '');
    } catch {
      return c.url;
    }
  }
  return parts.join(' · ') || 'source';
}
