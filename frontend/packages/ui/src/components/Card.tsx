import type { HTMLAttributes } from 'react';
import clsx from 'clsx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
}

export function Card({ title, description, className, children, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'group/card relative overflow-hidden rounded-2xl border border-neutral-200/70 bg-white/80 p-5 dark:border-neutral-800/70 dark:bg-neutral-900/70',
        'shadow-brand-sm backdrop-blur-sm transition-all',
        'hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-brand-md dark:hover:border-primary-700/60',
        className,
      )}
      {...rest}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary-300/50 to-transparent opacity-0 transition-opacity group-hover/card:opacity-100"
      />
      {title ? (
        <header className="mb-3">
          <h3 className="text-base font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{title}</h3>
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{description}</p>
          ) : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}
