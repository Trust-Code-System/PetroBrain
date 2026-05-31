import { forwardRef, type AnchorHTMLAttributes } from 'react';
import clsx from 'clsx';

export interface BackLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  label?: string;
}

/**
 * Branded "back" affordance - pairs a circular arrow button with a subtle
 * label. Renders as a plain anchor so it composes with `<Link>` (Next.js)
 * via `asChild`-style passthrough or wrapped in a Link with `legacyBehavior`.
 */
export const BackLink = forwardRef<HTMLAnchorElement, BackLinkProps>(function BackLink(
  { label = 'Back', className, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      className={clsx(
        'group inline-flex items-center gap-2.5 text-sm font-medium text-neutral-600 dark:text-neutral-300',
        'transition-colors hover:text-primary-700 dark:hover:text-primary-300',
        'focus:outline-none',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={clsx(
          'flex h-9 w-9 items-center justify-center rounded-full',
          'border border-neutral-200 bg-white/80 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/70',
          'transition-all duration-150',
          'group-hover:-translate-x-0.5 group-hover:border-primary-300 group-hover:bg-white group-hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.30)] dark:group-hover:border-primary-600 dark:group-hover:bg-neutral-900',
          'group-focus-visible:ring-2 group-focus-visible:ring-primary-300 group-focus-visible:ring-offset-2',
        )}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <path
            d="M12.5 5L7.5 10L12.5 15"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-neutral-600 transition-colors group-hover:text-primary-600 dark:text-neutral-300 dark:group-hover:text-primary-400"
          />
        </svg>
      </span>
      <span className="hidden sm:inline">{label}</span>
    </a>
  );
});
