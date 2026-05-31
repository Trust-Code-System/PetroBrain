/**
 * Wire types for the field calcs panel (B7).
 *
 * Match the FastAPI shapes in app/api/routes_calc.py + app/calc/catalog.py.
 * Pure TS - importable from Vitest without RN.
 */
export type CalcFamily = 'drilling' | 'production' | 'conversions' | string;

export interface CalcInputSpec {
  name: string;
  label: string;
  canonical_unit: string;
  accepted_units: string[];
  placeholder: number | null;
}

export interface CalcCatalogEntry {
  name: string;
  family: CalcFamily;
  label: string;
  summary: string;
  safety_critical: boolean;
  notes: string[];
  inputs: CalcInputSpec[];
}

export interface CalcResultDto {
  name: string;
  formula: string;
  inputs: Record<string, number>;
  result: number;
  unit: string;
  steps: string[];
  notes: string[];
  safety_critical: boolean;
}

export interface CalcResponse {
  calc: string;
  family: CalcFamily;
  submitted_units: Record<string, string>;
  result: CalcResultDto;
}

/** Local persistence (SQLite recent results). */
export interface RecentCalcRow {
  id: string;
  tenant_id: string;
  user_id: string;
  calc_name: string;
  family: CalcFamily;
  inputs_json: string;       // serialised {value, unit} per input
  result_json: string;       // serialised CalcResultDto
  created_utc: string;
}

/** Inflated form of a recent row - hydrated by the UI / list query. */
export interface RecentCalc {
  id: string;
  calc_name: string;
  family: CalcFamily;
  inputs: Record<string, { value: number; unit: string }>;
  result: CalcResultDto;
  created_utc: string;
}
