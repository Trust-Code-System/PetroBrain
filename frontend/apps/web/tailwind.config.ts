import type { Config } from 'tailwindcss';
// Shared preset from the design system - keeps tokens single-source.
import preset from '@petrobrain/ui/tailwind-preset';

const config: Config = {
  presets: [preset],
  content: [
    './app/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {},
  plugins: [],
};

export default config;
