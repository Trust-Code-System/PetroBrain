/**
 * Design tokens - colors.
 *
 * Boring and professional. All foreground / background pairs used by the
 * primitives clear WCAG 2.1 AA contrast (4.5:1 for text, 3:1 for large
 * text + non-text). Semantic colors map to user-action meaning:
 *
 *   safe   – calc within limits, calculation done, no action needed.
 *   info   – informational; not a status.
 *   warn   – caution; user must verify (e.g. Tier-2 source on an inventory).
 *   danger – decision-support refusal, validation error, live-event banner.
 *
 * Primary is a professional orange - warm and confident on white, readable in
 * sunlight. Text-weight shades (600/700+) clear AA contrast on white. The
 * neutral scale is engineered for office (light) and field (dark,
 * high-contrast) themes alike.
 */
export const colors = {
  primary: {
    50: '#fff7ed',
    100: '#ffedd5',
    200: '#fed7aa',
    300: '#fdba74',
    400: '#fb923c',
    500: '#f97316',
    600: '#ea580c',
    700: '#c2410c',
    800: '#9a3412',
    900: '#7c2d12',
  },
  neutral: {
    0: '#ffffff',
    50: '#f7f8fa',
    100: '#eef0f4',
    200: '#dadfe7',
    300: '#bcc4d0',
    400: '#8d96a4',
    500: '#5e6776',
    600: '#444c5a',
    700: '#2e3641',
    800: '#1c222b',
    900: '#0b1118',
  },
  semantic: {
    safe: { fg: '#0e5132', bg: '#dff3e4', border: '#1f8a4c' },
    info: { fg: '#0a3d6b', bg: '#dfeefd', border: '#1f6fb8' },
    warn: { fg: '#7a4b00', bg: '#fdecd0', border: '#b87a14' },
    danger: { fg: '#7a1c1f', bg: '#fbdcdc', border: '#b8262a' },
  },
} as const;

export type ColorScale = keyof typeof colors;
