import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { Module, Principal } from '@petrobrain/types';

import { decodePrincipal } from './jwt.js';

interface ChatStoreState {
  token: string | null;
  principal: Principal | null;
  module: Module;
  assetContext: string | null;
  apiBaseUrl: string;
  /**
   * False until zustand finishes hydrating from sessionStorage. Used by the
   * top-level chat surface to suppress the "Sign in" gate flash on a reload
   * while the persisted token is still being read.
   */
  hasHydrated: boolean;
  setToken: (token: string | null) => void;
  setModule: (m: Module) => void;
  setAssetContext: (asset: string | null) => void;
}

/**
 * Session state lives in sessionStorage - the token never touches localStorage
 * (would survive tab close) and never goes to the server (server verifies a
 * fresh Authorization header on every API call).
 */
export const useChatStore = create<ChatStoreState>()(
  persist(
    (set) => ({
      token: null,
      principal: null,
      module: 'general',
      assetContext: null,
      apiBaseUrl: typeof window === 'undefined'
        ? 'http://localhost:8000'
        : (window as Window & { __PB_API__?: string }).__PB_API__ ?? 'http://localhost:8000',
      hasHydrated: false,
      setToken: (token) => set({ token, principal: decodePrincipal(token) }),
      setModule: (module) => set({ module }),
      setAssetContext: (assetContext) => set({ assetContext }),
    }),
    {
      name: 'petrobrain-chat',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          // SSR no-op stub. The browser session takes over on hydrate.
          const stub: Storage = {
            length: 0,
            clear() {},
            getItem() { return null; },
            key() { return null; },
            removeItem() {},
            setItem() {},
          };
          return stub;
        }
        return window.sessionStorage;
      }),
      partialize: (s) => ({
        token: s.token,
        principal: s.principal,
        module: s.module,
        assetContext: s.assetContext,
      }),
      onRehydrateStorage: () => (state) => {
        // Re-derive the principal in case the persisted shape predates a schema bump.
        if (state?.token) state.principal = decodePrincipal(state.token);
        if (state) state.hasHydrated = true;
      },
    },
  ),
);
