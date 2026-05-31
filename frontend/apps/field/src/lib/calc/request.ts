/**
 * Form-input → POST /calc request shape (pure TS).
 *
 * Each input on the field form is a ``{value: string, unit: string}``
 * pair - strings because <TextInput> always hands them over as text. We
 * coerce to number, surface per-field parse errors, and refuse to
 * submit when anything is missing or NaN. All conversion still happens
 * server-side; the field never computes a result.
 */
import type { CalcCatalogEntry } from './types.js';

export interface CalcInputState {
  value: string;
  unit: string;
}

export type CalcFormState = Record<string, CalcInputState>;

export interface CalcRequestBody {
  name: string;
  inputs: Record<string, number>;
  units: Record<string, string>;
}

export interface BuildResult {
  ok: true;
  body: CalcRequestBody;
}
export interface BuildErrors {
  ok: false;
  errors: Record<string, string>;
}

export function emptyFormState(spec: CalcCatalogEntry): CalcFormState {
  const state: CalcFormState = {};
  for (const input of spec.inputs) {
    state[input.name] = {
      value: input.placeholder != null ? String(input.placeholder) : '',
      unit: input.canonical_unit,
    };
  }
  return state;
}

export function buildCalcRequest(
  spec: CalcCatalogEntry,
  form: CalcFormState,
): BuildResult | BuildErrors {
  const errors: Record<string, string> = {};
  const inputs: Record<string, number> = {};
  const units: Record<string, string> = {};

  for (const input of spec.inputs) {
    const field = form[input.name];
    if (!field || field.value.trim() === '') {
      errors[input.name] = 'Required.';
      continue;
    }
    const parsed = Number(field.value);
    if (!Number.isFinite(parsed)) {
      errors[input.name] = 'Must be a number.';
      continue;
    }
    if (!input.accepted_units.includes(field.unit)) {
      errors[input.name] = `Pick one of ${input.accepted_units.join(' / ')}.`;
      continue;
    }
    inputs[input.name] = parsed;
    units[input.name] = field.unit;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, body: { name: spec.name, inputs, units } };
}

/**
 * Group catalog entries by family in a stable order so the landing
 * screen renders Drilling / Production / Conversions in the same order
 * every load.
 */
const FAMILY_ORDER: Record<string, number> = {
  drilling: 0,
  production: 1,
  conversions: 2,
};

export function groupByFamily(entries: CalcCatalogEntry[]): Record<string, CalcCatalogEntry[]> {
  const grouped: Record<string, CalcCatalogEntry[]> = {};
  for (const entry of entries) {
    (grouped[entry.family] ??= []).push(entry);
  }
  for (const family of Object.keys(grouped)) {
    grouped[family]!.sort((a, b) => a.label.localeCompare(b.label));
  }
  return grouped;
}

export function sortedFamilies(grouped: Record<string, CalcCatalogEntry[]>): string[] {
  return Object.keys(grouped).sort((a, b) => {
    const aOrder = FAMILY_ORDER[a] ?? 99;
    const bOrder = FAMILY_ORDER[b] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });
}

const FAMILY_LABELS: Record<string, string> = {
  drilling: 'Drilling',
  production: 'Production',
  conversions: 'Conversions',
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}
