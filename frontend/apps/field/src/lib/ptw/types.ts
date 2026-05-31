/**
 * Permit-to-Work types, mirroring the backend ``app/modules/ptw``
 * shapes. Pure TS - importable from Vitest without RN.
 */
export const WORK_TYPES = [
  'hot_work',
  'cold_work',
  'confined_space',
  'working_at_height',
  'electrical',
  'excavation',
  'diving',
  'radiography',
  'lifting',
] as const;

export type WorkType = (typeof WORK_TYPES)[number];

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  hot_work: 'Hot work',
  cold_work: 'Cold work',
  confined_space: 'Confined space entry',
  working_at_height: 'Working at height',
  electrical: 'Electrical',
  excavation: 'Excavation',
  diving: 'Diving',
  radiography: 'Radiography',
  lifting: 'Lifting',
};

export type OutputFormat = 'permit' | 'toolbox_talk';

/** Form state - what the user enters on the field. */
export interface PtwFormState {
  job_description: string;
  location: string;
  work_type: WorkType;
  hazards: string[];
  controls: string[];
  isolations: string[];
  required_ppe: string[];
  issued_by: string;
  performing_authority: string;
  asset_id: string | null;
}

export const EMPTY_PTW_FORM: PtwFormState = {
  job_description: '',
  location: '',
  work_type: 'hot_work',
  hazards: [],
  controls: [],
  isolations: [],
  required_ppe: [],
  issued_by: '',
  performing_authority: '',
  asset_id: null,
};

/** Backend response shape - matches build_ptw() in app/modules/ptw/template.py. */
export interface PtwSignOffEntry {
  name: string | null;
  signed_utc: string | null;
}

export interface GeneratedPermit {
  permit_id: string;
  format: OutputFormat;
  work_type: string;
  location: string;
  job_description: string;
  issued_by: string;
  performing_authority: string;
  valid_from: string | null;
  valid_to: string | null;
  hazards: string[];
  controls: { supplied: string[]; suggested: string[]; merged: string[] };
  isolations: string[];
  required_ppe: { supplied: string[]; suggested: string[]; merged: string[] };
  sign_off: {
    permit_issuer: PtwSignOffEntry;
    performing_authority: PtwSignOffEntry;
  };
  status: 'draft_unsigned' | 'signed' | string;
  generated_utc: string;
  banner: string;
  safety_critical: true;
  audit_sha256: string;
  briefing?: string[];
}

/** Local persistence shape - what we store in SQLite. */
export interface SavedPermit {
  id: string;
  tenant_id: string;
  user_id: string;
  format: OutputFormat;
  status: 'draft_unsigned' | 'signed';
  created_utc: string;
  updated_utc: string;
  form: PtwFormState;
  generated: GeneratedPermit;
  signatures: PermitSignature[];
}

export interface PermitSignature {
  /** Free-form: "permit_issuer" | "performing_authority" | site-specific role. */
  role: string;
  name: string;
  signed_utc: string;
  /** Base64-encoded PNG of the signature glyph, if captured. */
  signature_png_b64?: string;
}
