/**
 * Display-side helpers for the data-readiness response.
 *
 * The backend computes the score itself - we never recompute. These
 * helpers translate the numeric score into a tone for the KPI badge
 * and surface a human readable status line.
 */
import type { DataReadiness } from './types.js';

export type ScoreTone = 'safe' | 'warn' | 'danger' | 'neutral';

export function scoreTone(pct: number): ScoreTone {
  if (pct >= 80) return 'safe';
  if (pct >= 50) return 'warn';
  if (pct > 0) return 'danger';
  return 'neutral';
}

export function statusLine(readiness: DataReadiness): string {
  if (readiness.readiness_pct === 0) return 'No data yet - tenant onboarding incomplete.';
  if (readiness.readiness_pct < 50) return 'Onboarding in progress - most data still missing.';
  if (readiness.readiness_pct < 80) {
    return 'Most data loaded; a handful of gaps remain before pilot launch.';
  }
  return 'Ready for pilot.';
}

export const ASSET_LEVELS = ['field', 'block', 'train', 'equipment'] as const;
export type AssetLevel = (typeof ASSET_LEVELS)[number];

export function missingAssetLevels(byType: Record<string, number>): AssetLevel[] {
  return ASSET_LEVELS.filter((level) => (byType[level] ?? 0) === 0);
}
