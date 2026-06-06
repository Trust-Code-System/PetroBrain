import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { ModuleSelection } from '@petrobrain/types';

export type SendShortcut = 'enter' | 'shift_enter';
export type Theme = 'light' | 'dark' | 'system';

export interface AppSettings {
  /** Friendly name used in the greeting; falls back to the signed-in account. */
  displayName: string;
  /** What PetroBrain should call the user - overrides displayName in greetings if set. */
  callMeName: string;
  /** Standing instructions prepended to the first turn of every new chat. */
  customInstructions: string;
  /** Which keystroke submits the composer. */
  sendShortcut: SendShortcut;
  /** Default module preselected when starting a new chat. */
  defaultModule: ModuleSelection;
  /** Whether to render markdown in answers (kept on by default). */
  renderMarkdown: boolean;
  /** Browser notification on long-running answer completion. */
  enableNotifications: boolean;
  /** Visual theme; 'system' follows the OS preference. */
  theme: Theme;
  hasHydrated: boolean;
}

interface SettingsActions {
  setDisplayName: (v: string) => void;
  setCallMeName: (v: string) => void;
  setCustomInstructions: (v: string) => void;
  setSendShortcut: (v: SendShortcut) => void;
  setDefaultModule: (v: ModuleSelection) => void;
  setRenderMarkdown: (v: boolean) => void;
  setEnableNotifications: (v: boolean) => void;
  setTheme: (v: Theme) => void;
  resetAll: () => void;
}

const DEFAULTS: Omit<AppSettings, 'hasHydrated'> = {
  displayName: '',
  callMeName: '',
  customInstructions: '',
  sendShortcut: 'enter',
  defaultModule: 'auto',
  renderMarkdown: true,
  enableNotifications: false,
  theme: 'system',
};

export const useSettingsStore = create<AppSettings & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      hasHydrated: false,
      setDisplayName: (displayName) => set({ displayName }),
      setCallMeName: (callMeName) => set({ callMeName }),
      setCustomInstructions: (customInstructions) => set({ customInstructions }),
      setSendShortcut: (sendShortcut) => set({ sendShortcut }),
      setDefaultModule: (defaultModule) => set({ defaultModule }),
      setRenderMarkdown: (renderMarkdown) => set({ renderMarkdown }),
      setEnableNotifications: (enableNotifications) => set({ enableNotifications }),
      setTheme: (theme) => set({ theme }),
      resetAll: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'petrobrain-settings',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
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
        return window.localStorage;
      }),
      partialize: (s) => ({
        displayName: s.displayName,
        callMeName: s.callMeName,
        customInstructions: s.customInstructions,
        sendShortcut: s.sendShortcut,
        defaultModule: s.defaultModule,
        renderMarkdown: s.renderMarkdown,
        enableNotifications: s.enableNotifications,
        theme: s.theme,
      }),
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Partial<AppSettings>;
        if (version < 2 && state.defaultModule === 'general') {
          state.defaultModule = 'auto';
        }
        return state as AppSettings & SettingsActions;
      },
      onRehydrateStorage: () => (state) => {
        if (state) state.hasHydrated = true;
      },
    },
  ),
);
