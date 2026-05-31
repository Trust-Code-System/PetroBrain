import { create } from 'zustand';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import type { Principal } from '@petrobrain/types';

import {
  DEFAULT_PREFERENCES,
  preferencesReducer,
  type Language,
  type Preferences,
  type TextSize,
} from '../settings/preferences.js';
import { decodePrincipal } from './jwt.js';

const SECURE_TOKEN_KEY = 'petrobrain.token';
const PREFS_KEY = 'petrobrain.prefs';

interface SessionState {
  hydrated: boolean;
  token: string | null;
  principal: Principal | null;
  apiBaseUrl: string;
  preferences: Preferences;
  setToken: (token: string | null) => Promise<void>;
  setLanguage: (language: Language) => Promise<void>;
  setTextSize: (textSize: TextSize) => Promise<void>;
  setApiBaseUrl: (url: string) => Promise<void>;
  hydrate: () => Promise<void>;
}

/**
 * Session state for the field app.
 *
 * The token sits in expo-secure-store (Keychain on iOS, Keystore on
 * Android) - never AsyncStorage. Preferences and the api base URL go to
 * SecureStore too so they survive a process kill without exposing
 * anything sensitive at rest.
 *
 * ``hydrate`` runs once at app boot from ``_layout.tsx``. UI is held in
 * the hydrating state until then so we don't briefly show the auth gate
 * before the saved token loads.
 */
export const useSessionStore = create<SessionState>((set, get) => ({
  hydrated: false,
  token: null,
  principal: null,
  apiBaseUrl: readDefaultApiBaseUrl(),
  preferences: DEFAULT_PREFERENCES,
  setToken: async (token) => {
    if (token) await SecureStore.setItemAsync(SECURE_TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(SECURE_TOKEN_KEY);
    set({ token, principal: decodePrincipal(token) });
  },
  setLanguage: async (language) => {
    const next = preferencesReducer(get().preferences, { type: 'setLanguage', language });
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(next));
    set({ preferences: next });
  },
  setTextSize: async (textSize) => {
    const next = preferencesReducer(get().preferences, { type: 'setTextSize', textSize });
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(next));
    set({ preferences: next });
  },
  setApiBaseUrl: async (url) => {
    await SecureStore.setItemAsync('petrobrain.api_base_url', url);
    set({ apiBaseUrl: url });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const [token, rawPrefs, savedUrl] = await Promise.all([
        SecureStore.getItemAsync(SECURE_TOKEN_KEY),
        SecureStore.getItemAsync(PREFS_KEY),
        SecureStore.getItemAsync('petrobrain.api_base_url'),
      ]);
      let preferences: Preferences = DEFAULT_PREFERENCES;
      if (rawPrefs) {
        try {
          const parsed = JSON.parse(rawPrefs) as Preferences;
          if (parsed.language && parsed.textSize) preferences = parsed;
        } catch {
          // Corrupt prefs blob - fall back to defaults silently.
        }
      }
      set({
        hydrated: true,
        token: token ?? null,
        principal: decodePrincipal(token),
        preferences,
        apiBaseUrl: savedUrl ?? readDefaultApiBaseUrl(),
      });
    } catch {
      // SecureStore unavailable (web preview, simulator quirks) - still
      // flip ``hydrated`` so the UI renders.
      set({ hydrated: true });
    }
  },
}));

function readDefaultApiBaseUrl(): string {
  const fromManifest = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)
    ?.apiBaseUrl;
  return fromManifest ?? 'http://localhost:8000';
}
