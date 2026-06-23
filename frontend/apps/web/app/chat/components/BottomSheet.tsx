'use client';

import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import clsx from 'clsx';

/**
 * Mobile-only bottom sheet. Slides up from the bottom edge over a tap-to-
 * dismiss scrim, with a drag handle and swipe-down-to-close, the way the
 * Claude/ChatGPT mobile apps present secondary surfaces. It is `md:hidden`,
 * so callers can render it alongside a desktop panel and let the breakpoint
 * decide which one shows.
 *
 * Presence is the open state: the parent mounts the sheet to open it and
 * unmounts to close it. The slide-in plays on mount; close is immediate
 * (the parent removes it), which keeps the state model simple and avoids a
 * stuck-half-open sheet.
 */
export function BottomSheet({
  onClose,
  label,
  children,
}: {
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  children: ReactNode;
}) {
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  function onTouchStart(e: TouchEvent) {
    startY.current = e.touches[0]?.clientY ?? null;
    setDragging(true);
  }
  function onTouchMove(e: TouchEvent) {
    if (startY.current === null) return;
    const dy = (e.touches[0]?.clientY ?? startY.current) - startY.current;
    // Only track downward drags; an upward pull does nothing.
    setDragY(dy > 0 ? dy : 0);
  }
  function onTouchEnd() {
    setDragging(false);
    // A decisive pull (or a flick past the threshold) dismisses; otherwise
    // the sheet springs back to its resting position.
    if (dragY > 90) onClose();
    else setDragY(0);
    startY.current = null;
  }

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={clsx(
          'fixed inset-0 z-40 bg-neutral-950/40 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none',
          entered ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={entered ? { transform: `translateY(${dragY}px)` } : undefined}
        className={clsx(
          'fixed inset-x-0 bottom-0 top-[max(1.5rem,env(safe-area-inset-top))] z-50 flex flex-col overflow-hidden rounded-t-3xl border border-b-0 border-neutral-200/60 bg-gradient-to-b from-white via-white to-primary-50/30 shadow-[0_-12px_40px_-12px_rgba(15,23,42,0.45)] dark:border-neutral-800/60 dark:from-neutral-950 dark:via-neutral-950 dark:to-primary-900/20',
          dragging ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none',
          entered ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
        >
          <span aria-hidden className="h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
        {children}
      </div>
    </div>
  );
}
