/**
 * Shared Tailwind preset.
 *
 * apps/web and apps/admin extend this so their utility classes resolve
 * to the same numeric tokens as the React primitives. Field app uses the
 * tokens directly via @petrobrain/ui/tokens.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
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
          950: '#431407',
        },
        safe: { fg: '#0e5132', bg: '#dff3e4', border: '#1f8a4c' },
        info: { fg: '#0a3d6b', bg: '#dfeefd', border: '#1f6fb8' },
        warn: { fg: '#7a4b00', bg: '#fdecd0', border: '#b87a14' },
        danger: { fg: '#7a1c1f', bg: '#fbdcdc', border: '#b8262a' },
        brand: { fg: '#7c2d12', bg: '#fff7ed', border: '#ea580c' },
      },
      borderRadius: {
        sm: '2px',
        md: '4px',
        lg: '8px',
        xl: '12px',
        pill: '9999px',
      },
      minHeight: { tap: '56px' },
      minWidth: { tap: '56px' },
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', '"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        'brand-sm': '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 1px rgba(15, 23, 42, 0.04)',
        'brand-md': '0 6px 16px -6px rgba(15, 23, 42, 0.12), 0 2px 4px rgba(15, 23, 42, 0.05)',
        'brand-lg': '0 24px 48px -16px rgba(15, 23, 42, 0.18), 0 6px 12px -4px rgba(15, 23, 42, 0.08)',
        'brand-primary': '0 10px 24px -8px rgba(234, 88, 12, 0.45), 0 2px 4px rgba(194, 65, 12, 0.18)',
        'brand-primary-lg': '0 18px 40px -12px rgba(234, 88, 12, 0.55), 0 4px 8px rgba(194, 65, 12, 0.22)',
        'inner-soft': 'inset 0 1px 0 rgba(255, 255, 255, 0.5)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #fb923c 0%, #ea580c 50%, #c2410c 100%)',
        'brand-gradient-soft': 'linear-gradient(135deg, #ffedd5 0%, #fed7aa 100%)',
      },
      keyframes: {
        'pb-shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pb-thinking-pulse': {
          '0%, 80%, 100%': { opacity: '0.25', transform: 'scale(0.85)' },
          '40%': { opacity: '1', transform: 'scale(1)' },
        },
        'pb-caret-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
      animation: {
        'pb-shimmer': 'pb-shimmer 2.4s linear infinite',
        'pb-thinking': 'pb-thinking-pulse 1.4s ease-in-out infinite',
        'pb-caret': 'pb-caret-blink 1s steps(2) infinite',
      },
    },
  },
};
