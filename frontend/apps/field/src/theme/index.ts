/**
 * Field-app theme - derives from the shared ``@petrobrain/ui/tokens`` so
 * sunlight-readable colour pairs stay consistent with web. The field
 * surface only needs a dark + light pair; we don't carry an entire
 * theming runtime.
 */
import { colors, spacing, typography } from '@petrobrain/ui/tokens';

import { fontScale, type TextSize } from '../lib/settings/preferences.js';

export type ThemeMode = 'light' | 'dark';

export interface FieldTheme {
  mode: ThemeMode;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryFg: string;
  banner: { safe: string; info: string; warn: string; danger: string };
  bannerFg: { safe: string; info: string; warn: string; danger: string };
  spacing: typeof spacing;
  typography: typeof typography;
}

const LIGHT: FieldTheme = {
  mode: 'light',
  surface: colors.neutral[0],
  surfaceMuted: colors.neutral[50],
  text: colors.neutral[800],
  textMuted: colors.neutral[500],
  border: colors.neutral[200],
  primary: colors.primary[600],
  primaryFg: colors.neutral[0],
  banner: {
    safe: colors.semantic.safe.bg,
    info: colors.semantic.info.bg,
    warn: colors.semantic.warn.bg,
    danger: colors.semantic.danger.bg,
  },
  bannerFg: {
    safe: colors.semantic.safe.fg,
    info: colors.semantic.info.fg,
    warn: colors.semantic.warn.fg,
    danger: colors.semantic.danger.fg,
  },
  spacing,
  typography,
};

const DARK: FieldTheme = {
  ...LIGHT,
  mode: 'dark',
  surface: colors.neutral[900],
  surfaceMuted: colors.neutral[800],
  text: colors.neutral[50],
  textMuted: colors.neutral[300],
  border: colors.neutral[700],
};

export function getTheme(mode: ThemeMode): FieldTheme {
  return mode === 'dark' ? DARK : LIGHT;
}

export function scaleFontSize(base: number, textSize: TextSize): number {
  return Math.round(base * fontScale(textSize));
}
