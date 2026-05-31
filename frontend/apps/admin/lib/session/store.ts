import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { decodeAdminPrincipal, type AdminPrincipal } from './jwt.js';

interface AdminSessionState {
  token: string | null;
  principal: AdminPrincipal | null;
  apiBaseUrl: string;
  setToken: (token: string | null) => void;
}

/**
 * Admin console session: token in sessionStorage (never localStorage -
 * tabs that close shouldn't leak the platform-admin token).
 */
export const useAdminSession = create<AdminSessionState>()(
  persist(
    (set) => ({
      token: null,
      principal: null,
      apiBaseUrl:
        typeof window === 'undefined'
          ? 'http://localhost:8000'
          : ((window as Window & { __PB_API__?: string }).__PB_API__ ??
            'http://localhost:8000'),
      setToken: (token) => set({ token, principal: decodeAdminPrincipal(token) }),
    }),
    {
      name: 'petrobrain-admin',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          const stub: Storage = {
            length: 0,
            clear() {},
            getItem() {
              return null;
            },
            key() {
              return null;
            },
            removeItem() {},
            setItem() {},
          };
          return stub;
        }
        return window.sessionStorage;
      }),
      partialize: (s) => ({ token: s.token, principal: s.principal }),
      onRehydrateStorage: () => (state) => {
        if (state?.token) state.principal = decodeAdminPrincipal(state.token);
      },
    },
  ),
);
