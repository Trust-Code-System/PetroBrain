/**
 * Pure-TS reducer for the PTW form state.
 *
 * Kept out of the React tree so we can unit-test every transition under
 * Vitest. The screen wraps the reducer with ``useReducer`` and a couple
 * of side-effects (Save / Generate / Sign).
 */
import { EMPTY_PTW_FORM, WORK_TYPES, type PtwFormState, type WorkType } from './types.js';

export type PtwFormAction =
  | { type: 'set_field'; field: 'job_description' | 'location' | 'issued_by' | 'performing_authority'; value: string }
  | { type: 'set_work_type'; value: WorkType }
  | { type: 'set_asset'; value: string | null }
  | { type: 'add_chip'; field: 'hazards' | 'controls' | 'isolations' | 'required_ppe'; value: string }
  | { type: 'remove_chip'; field: 'hazards' | 'controls' | 'isolations' | 'required_ppe'; index: number }
  | { type: 'replace_chips'; field: 'hazards' | 'controls' | 'isolations' | 'required_ppe'; values: string[] }
  | { type: 'reset' };

export function ptwFormReducer(state: PtwFormState, action: PtwFormAction): PtwFormState {
  switch (action.type) {
    case 'set_field':
      return { ...state, [action.field]: action.value };
    case 'set_work_type':
      // Coerce defensively - the UI uses a typed Select but reducer
      // tests pass plain strings.
      if (!isWorkType(action.value)) return state;
      return { ...state, work_type: action.value };
    case 'set_asset':
      return { ...state, asset_id: action.value };
    case 'add_chip': {
      const next = action.value.trim();
      if (!next) return state;
      const current = state[action.field];
      if (current.includes(next)) return state;
      return { ...state, [action.field]: [...current, next] };
    }
    case 'remove_chip': {
      const current = state[action.field];
      if (action.index < 0 || action.index >= current.length) return state;
      const next = current.slice();
      next.splice(action.index, 1);
      return { ...state, [action.field]: next };
    }
    case 'replace_chips': {
      // Dedupe + drop blanks to keep the wire payload tidy.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of action.values) {
        const trimmed = raw.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
      }
      return { ...state, [action.field]: cleaned };
    }
    case 'reset':
      return EMPTY_PTW_FORM;
    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

function isWorkType(value: string): value is WorkType {
  return (WORK_TYPES as readonly string[]).includes(value);
}

/**
 * Validates that the minimum required fields are present. Mirrors the
 * backend's ``PtwInputs.__post_init__`` so we fail locally with the
 * same error before round-tripping to the LLM.
 */
export function validatePtwForm(state: PtwFormState): string[] {
  const errors: string[] = [];
  if (!state.job_description.trim()) errors.push('Job description is required.');
  if (!state.location.trim()) errors.push('Location is required.');
  if (!isWorkType(state.work_type)) errors.push('Work type is required.');
  return errors;
}
