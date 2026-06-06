'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';

import type { Module } from '@petrobrain/types';
import { Select } from '@petrobrain/ui';

import { fetchAssets } from '@/lib/chat/assets';
import { useChatStore } from '@/lib/chat/store';

const MODULES: { value: Module; label: string; description: string }[] = [
  { value: 'general', label: 'General', description: 'Domain-locked Q&A across SOPs and standards.' },
  { value: 'research', label: 'RESEARCH', description: 'Cited sector, regulatory, market, and investment analysis.' },
  { value: 'well_control', label: 'Well Control', description: 'Kill sheets, kick detection, shut-in math.' },
  { value: 'emissions_mrv', label: 'Emissions / MRV', description: 'NUPRC Tier-3 inventories + GHGEMP.' },
  { value: 'ptw', label: 'PTW', description: 'Controlled permit-to-work templates and verification.' },
];

/**
 * Compact pill button styled like ChatGPT's model picker - clicked to reveal
 * a popover with module + asset-context selectors. Keeps both controls
 * accessible without two sidebar fields competing for space.
 */
export function ModulePill() {
  const token = useChatStore((s) => s.token);
  const apiBaseUrl = useChatStore((s) => s.apiBaseUrl);
  const module = useChatStore((s) => s.module);
  const setModule = useChatStore((s) => s.setModule);
  const assetContext = useChatStore((s) => s.assetContext);
  const setAssetContext = useChatStore((s) => s.setAssetContext);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const assets = useQuery({
    queryKey: ['assets', 'roots'],
    queryFn: ({ signal }) =>
      fetchAssets({ baseUrl: apiBaseUrl, token: token!, rootsOnly: true, signal }),
    enabled: Boolean(token),
  });

  const current = useMemo(() => MODULES.find((m) => m.value === module) ?? MODULES[0]!, [module]);
  const activeAsset = useMemo(
    () => (assets.data ?? []).find((a) => a.id === assetContext) ?? null,
    [assets.data, assetContext],
  );

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
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

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open ? 'true' : 'false'}
        className={clsx(
          'group flex h-9 items-center gap-2 rounded-full border border-neutral-200/70 bg-white/80 pl-2.5 pr-3 text-sm text-neutral-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur transition-all dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-200',
          'hover:border-primary-300 hover:bg-white hover:text-primary-700 hover:shadow-[0_4px_12px_-4px_rgba(234,88,12,0.25)] dark:hover:border-primary-600 dark:hover:bg-neutral-900 dark:hover:text-primary-300',
          open && 'border-primary-300 bg-white text-primary-700 shadow-[0_4px_12px_-4px_rgba(234,88,12,0.25)] dark:border-primary-600 dark:bg-neutral-900 dark:text-primary-300',
        )}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
          PB
        </span>
        <span className="font-semibold tracking-tight">{current.label}</span>
        {activeAsset ? (
          <span className="hidden items-center gap-1 border-l border-neutral-200 pl-2 text-xs font-medium text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 sm:flex">
            <svg width="11" height="11" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 2.5l7 4v7l-7 4-7-4v-7l7-4z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            <span className="max-w-[10rem] truncate">{activeAsset.name}</span>
          </span>
        ) : null}
        <svg
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="none"
          className={clsx('text-neutral-500 transition-transform dark:text-neutral-400', open && 'rotate-180')}
        >
          <path
            d="M5 7.5L10 12.5L15 7.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Conversation context"
          className="absolute left-0 top-[calc(100%+8px)] z-50 w-[22rem] overflow-visible rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_48px_-16px_rgba(15,23,42,0.20),0_6px_12px_-4px_rgba(15,23,42,0.10)] dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div className="border-b border-neutral-100 px-3 py-2.5 dark:border-neutral-800">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400">
              Module
            </p>
          </div>
          <ul className="py-1.5">
            {MODULES.map((m) => {
              const selected = m.value === module;
              return (
                <li key={m.value}>
                  <button
                    type="button"
                    onClick={() => {
                      setModule(m.value);
                      setOpen(false);
                    }}
                    className={clsx(
                      'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors',
                      selected ? 'bg-primary-50/70 dark:bg-primary-900/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                    )}
                  >
                    <span
                      className={clsx(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                        selected
                          ? 'border-primary-500 bg-primary-500 text-white'
                          : 'border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-800',
                      )}
                    >
                      {selected ? (
                        <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
                          <path
                            d="M5 10.5L8.5 14L15 7"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={clsx(
                          'text-sm font-semibold',
                          selected ? 'text-primary-800 dark:text-primary-200' : 'text-neutral-900 dark:text-neutral-100',
                        )}
                      >
                        {m.label}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                        {m.description}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-neutral-100 bg-neutral-50/60 px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900/60">
            <Select
              label="Asset context"
              value={assetContext ?? ''}
              onChange={(e) => {
                setAssetContext(e.target.value || null);
                setOpen(false);
              }}
              options={[
                { value: '', label: '- No asset context -' },
                ...((assets.data ?? []).map((a) => ({
                  value: a.id,
                  label: `${a.type}: ${a.name}`,
                }))),
              ]}
              {...(assets.isError
                ? { error: 'Could not load assets. Sign in again or try later.' }
                : assets.isLoading
                  ? { hint: 'Loading assets…' }
                  : { hint: 'Filters retrieved citations to the relevant asset.' })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
