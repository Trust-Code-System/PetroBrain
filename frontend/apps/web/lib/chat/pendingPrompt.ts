import { create } from 'zustand';

/**
 * Cross-route handoff for a one-shot prompt the user picked from the
 * Customize directory. The /chat surface drains this on mount and pre-fills
 * the composer; intentionally **not** persisted - refreshing the page should
 * not re-trigger an already-consumed skill.
 */
interface PendingPromptState {
  pending: string | null;
  setPending: (prompt: string | null) => void;
  consume: () => string | null;
}

export const usePendingPromptStore = create<PendingPromptState>((set, get) => ({
  pending: null,
  setPending: (prompt) => set({ pending: prompt }),
  consume: () => {
    const current = get().pending;
    if (current !== null) set({ pending: null });
    return current;
  },
}));
