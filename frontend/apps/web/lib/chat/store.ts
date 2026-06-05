import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { Module, Principal } from '@petrobrain/types';

import { decodePrincipal } from './jwt.js';

interface PrincipalPayload {
  user_id: string;
  tenant_id: string;
  role: Principal['role'];
  email?: string;
  allowed_assets?: string[];
}

export type ThinkingMode = 'instant' | 'default' | 'extended';

/**
 * Resolve the API base URL. In dev the localhost fallback is fine; in any
 * non-dev build we refuse to fall back so a deploy that forgot to set
 * NEXT_PUBLIC_API_BASE_URL fails loudly rather than silently calling
 * http://localhost:8000 from a customer browser.
 */
function resolveApiBaseUrl(): string {
  const runtime =
    typeof window !== 'undefined'
      ? (window as Window & { __PB_API__?: string }).__PB_API__
      : undefined;
  const env = process.env.NEXT_PUBLIC_API_BASE_URL;
  const resolved = runtime ?? env;
  if (resolved) return resolved;
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv && nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL is not set. Refusing to fall back to ' +
        'http://localhost:8000 in a non-development build.',
    );
  }
  return 'http://localhost:8000';
}

interface ChatStoreState {
  token: string | null;
  principal: Principal | null;
  module: Module;
  assetContext: string | null;
  thinkingMode: ThinkingMode;
  apiBaseUrl: string;
  /** Default true. Composer + menu lets the user disable for the next turn. */
  webSearchEnabled: boolean;
  /**
   * One-shot toggle: when true, the next assistant message auto-opens in canvas
   * regardless of length. ChatClient resets it once consumed.
   */
  forceCanvasNext: boolean;
  /** When true, the chat sidebar collapses to a 3.5rem icon-only rail. */
  sidebarCollapsed: boolean;
  /**
   * False until zustand finishes hydrating from sessionStorage. Used by the
   * top-level chat surface to suppress the "Sign in" gate flash on a reload
   * while the persisted token is still being read.
   */
  hasHydrated: boolean;
  /**
   * Set when the backend tells us the JWT is no longer valid (expired,
   * revoked, etc). The signin page reads this and surfaces a friendly
   * "your session expired" banner instead of the user wondering why they
   * suddenly have to re-authenticate. Cleared on successful sign-in.
   */
  sessionExpiredReason: 'expired' | 'revoked' | 'invalid' | null;
  setToken: (token: string | null, principal?: PrincipalPayload | null) => void;
  setModule: (m: Module) => void;
  setAssetContext: (asset: string | null) => void;
  setThinkingMode: (m: ThinkingMode) => void;
  setWebSearchEnabled: (enabled: boolean) => void;
  setForceCanvasNext: (force: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /**
   * Convenience: clear the JWT AND remember why so the signin page can
   * show the right banner. ChatClient calls this when a request fails
   * with 401 / token-expired so the user never sees raw error JSON.
   */
  expireSession: (reason: 'expired' | 'revoked' | 'invalid') => void;
  /** Called by AuthForm on successful sign-in to clear the banner. */
  clearSessionExpired: () => void;
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
      thinkingMode: 'default',
      apiBaseUrl: resolveApiBaseUrl(),
      webSearchEnabled: true,
      forceCanvasNext: false,
      sidebarCollapsed: false,
      hasHydrated: false,
      sessionExpiredReason: null,
      setToken: (token, principalPayload) =>
        set({
          token,
          principal: principalPayload ? principalFromPayload(principalPayload) : decodePrincipal(token),
        }),
      setModule: (module) => set({ module }),
      setAssetContext: (assetContext) => set({ assetContext }),
      setThinkingMode: (thinkingMode) => set({ thinkingMode }),
      setWebSearchEnabled: (webSearchEnabled) => set({ webSearchEnabled }),
      setForceCanvasNext: (forceCanvasNext) => set({ forceCanvasNext }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      expireSession: (reason) =>
        set({ token: null, principal: null, sessionExpiredReason: reason }),
      clearSessionExpired: () => set({ sessionExpiredReason: null }),
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
        thinkingMode: s.thinkingMode,
        webSearchEnabled: s.webSearchEnabled,
        sidebarCollapsed: s.sidebarCollapsed,
        // forceCanvasNext is intentionally NOT persisted - it's a one-shot
        // intent for the next send; reload should not silently force-open the
        // canvas on the next turn.
      }),
      onRehydrateStorage: () => (state) => {
        // Re-derive the principal in case the persisted shape predates a schema bump.
        if (state?.token) state.principal = decodePrincipal(state.token);
        if (state) state.hasHydrated = true;
      },
    },
  ),
);

function principalFromPayload(payload: PrincipalPayload): Principal {
  return {
    tenantId: payload.tenant_id,
    userId: payload.user_id,
    ...(payload.email ? { email: payload.email } : {}),
    role: payload.role,
    allowedAssets: Array.isArray(payload.allowed_assets)
      ? payload.allowed_assets.filter((x): x is string => typeof x === 'string')
      : [],
  };
}
