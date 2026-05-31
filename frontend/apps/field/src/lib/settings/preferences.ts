/**
 * User preferences (pure TS - no RN imports, so the reducer is testable
 * under Vitest without a JS engine that knows about react-native).
 *
 * Persistence happens in a separate ``preferences.store.ts`` (later)
 * which wraps AsyncStorage / SecureStore around this reducer.
 */
export const LANGUAGES = ['en', 'pidgin', 'yo', 'ha'] as const;
export type Language = (typeof LANGUAGES)[number];

export const TEXT_SIZES = ['small', 'medium', 'large'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const SUPPORTED_LANGUAGES: Set<Language> = new Set(['en']);

export interface Preferences {
  language: Language;
  textSize: TextSize;
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: 'en',
  textSize: 'medium',
};

export type PreferenceAction =
  | { type: 'setLanguage'; language: Language }
  | { type: 'setTextSize'; textSize: TextSize }
  | { type: 'reset' };

export function preferencesReducer(state: Preferences, action: PreferenceAction): Preferences {
  switch (action.type) {
    case 'setLanguage':
      // Phase-1 honours the user's explicit choice but silently ignores
      // an unsupported language (Pidgin/Yoruba/Hausa land in a later
      // task once we have a translation pipeline).
      return SUPPORTED_LANGUAGES.has(action.language)
        ? { ...state, language: action.language }
        : state;
    case 'setTextSize':
      return { ...state, textSize: action.textSize };
    case 'reset':
      return DEFAULT_PREFERENCES;
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

export function fontScale(textSize: TextSize): number {
  switch (textSize) {
    case 'small':
      return 0.9;
    case 'medium':
      return 1;
    case 'large':
      return 1.25;
  }
}
