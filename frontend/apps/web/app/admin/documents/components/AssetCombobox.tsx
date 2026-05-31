'use client';

import { useId, useMemo, useState } from 'react';
import clsx from 'clsx';

import type { AssetNode } from '@petrobrain/types';

export interface AssetComboboxProps {
  label: string;
  value: string | null;
  onChange: (assetId: string | null) => void;
  assets: AssetNode[];
  hint?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * Lightweight asset autocomplete (B3).
 *
 * Intentionally not a real combobox primitive - that lands in the shared
 * UI package once the field app needs one too. For now: an Input filters
 * the loaded asset list by substring and a small dropdown lets the admin
 * pick by mouse or keyboard.
 */
export function AssetCombobox({
  label,
  value,
  onChange,
  assets,
  hint,
  error,
  disabled,
}: AssetComboboxProps) {
  const listId = useId();
  const inputId = `${listId}-input`;

  const selected = useMemo(() => assets.find((a) => a.id === value) ?? null, [assets, value]);
  const [query, setQuery] = useState(selected ? formatAsset(selected) : '');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return assets.slice(0, 8);
    return assets
      .filter(
        (a) =>
          a.name.toLowerCase().includes(trimmed) ||
          a.id.toLowerCase().includes(trimmed) ||
          a.type.toLowerCase().includes(trimmed),
      )
      .slice(0, 8);
  }, [assets, query]);

  function pick(asset: AssetNode | null) {
    onChange(asset?.id ?? null);
    setQuery(asset ? formatAsset(asset) : '');
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (value !== null) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 100)}
          placeholder="No asset context"
          className={clsx(
            'h-11 w-full rounded-xl border bg-white px-3.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all dark:bg-neutral-900 dark:text-neutral-100',
            'placeholder:text-neutral-400 hover:border-primary-300 dark:placeholder:text-neutral-500 dark:hover:border-primary-600',
            'focus:outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-200 dark:focus:border-primary-500 dark:focus:ring-primary-800',
            error
              ? 'border-danger-border focus:ring-danger-border dark:border-danger-border/60'
              : 'border-neutral-200 dark:border-neutral-700',
          )}
        />
        {open ? (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-30 mt-1.5 max-h-64 w-full overflow-auto rounded-xl border border-neutral-200 bg-white py-1.5 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.18),0_4px_10px_-2px_rgba(15,23,42,0.08)] dark:border-neutral-700 dark:bg-neutral-900"
          >
            <li
              role="option"
              aria-selected={value === null}
              className="mx-1.5 cursor-pointer rounded-lg px-3 py-2 text-sm text-neutral-500 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800/60"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(null);
              }}
            >
              - No asset context -
            </li>
            {filtered.map((asset) => (
              <li
                key={asset.id}
                role="option"
                aria-selected={asset.id === value}
                className={clsx(
                  'mx-1.5 cursor-pointer rounded-lg px-3 py-2 text-sm transition-colors hover:bg-primary-50 dark:hover:bg-primary-900/30',
                  asset.id === value && 'bg-primary-50 text-primary-800 dark:bg-primary-900/30 dark:text-primary-200',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(asset);
                }}
              >
                <div className="font-medium text-neutral-800 dark:text-neutral-100">{asset.name}</div>
                <div className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                  {asset.type} · {asset.id}
                </div>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400">No assets match.</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {hint && !error ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-danger-fg dark:text-danger-bg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function formatAsset(a: AssetNode): string {
  return `${a.name} (${a.type})`;
}
