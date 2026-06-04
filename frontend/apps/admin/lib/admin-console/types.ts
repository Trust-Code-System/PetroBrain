/**
 * Wire types for the admin console (B8). Mirror the FastAPI schemas in
 * ``app/api/routes_admin_tenants.py``, ``routes_admin_users.py``, and
 * ``routes_admin_data_readiness.py``. Pure TS - Vitest-friendly.
 */
export type TenantStatus = 'active' | 'suspended';

export interface TenantRow {
  id: string;
  name: string;
  status: TenantStatus;
  attributes: Record<string, unknown>;
  created_utc: string;
  updated_utc: string;
}

export type UserRole = 'platform_admin' | 'admin' | 'engineer' | 'field' | 'hse';
export type UserStatus = 'invited' | 'active' | 'deactivated';

export const USER_ROLES: UserRole[] = ['platform_admin', 'admin', 'engineer', 'field', 'hse'];
export const USER_STATUSES: UserStatus[] = ['invited', 'active', 'deactivated'];

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  allowed_assets: string[];
  invited_at_utc: string;
  last_active_utc: string | null;
  created_utc: string;
  updated_utc: string;
}

export interface DataReadiness {
  tenant_id: string;
  readiness_pct: number;
  documents: { loaded: number; indexed: number; failed: number; score_pct: number };
  assets: { total: number; by_type: Record<string, number>; score_pct: number };
  users: { active: number; pending_invites: number; score_pct: number };
  connectors: { status: string; note: string; score_pct: number };
  weights: { documents: number; assets: number; users: number; connectors: number };
}

export interface AuditEventRow {
  id: number;
  ts: string;
  tenant_id: string;
  user_id: string;
  role: string;
  action: string;
  module: string;
  request_hash: string;
  response_hash: string;
  retrieved_clauses: unknown[];
  flags: string[];
  usage: Record<string, unknown>;
}

// ---- Learning loop (feedback, memory, retrieval weights) ----------------

export type FeedbackRating = 'up' | 'down';

export interface FeedbackRow {
  id: string;
  tenant_id: string;
  user_id: string;
  turn_id: string;
  rating: FeedbackRating;
  reason: string | null;
  module: string | null;
  metadata: Record<string, unknown>;
  created_utc: string;
}

export interface FeedbackSummary {
  tenant_id: string;
  up: number;
  down: number;
  total: number;
}

export type MemoryKind = 'terminology' | 'preference' | 'context';
export type MemoryStatus = 'active' | 'archived';
export type MemorySource = 'manual' | 'promoted_feedback';

export const MEMORY_KINDS: MemoryKind[] = ['terminology', 'preference', 'context'];

export interface MemoryRow {
  id: string;
  tenant_id: string;
  kind: MemoryKind;
  body: string;
  source: MemorySource;
  source_feedback_id: string | null;
  status: MemoryStatus;
  created_by: string;
  created_utc: string;
  updated_utc: string;
}

export interface ChunkWeightRow {
  tenant_id: string;
  chunk_id: number;
  weight: number;
  up_count: number;
  down_count: number;
  last_updated: string;
}

export interface FeedbackTrendPoint {
  day: string;        // YYYY-MM-DD, UTC
  up: number;
  down: number;
}

export interface FeedbackTrend {
  tenant_id: string;
  days: number;
  series: FeedbackTrendPoint[];
}

export interface MemoryTrendPoint {
  week_start: string; // YYYY-MM-DD (Monday)
  manual: number;
  promoted: number;
}

export interface MemoryTrend {
  tenant_id: string;
  weeks: number;
  series: MemoryTrendPoint[];
}

export interface GlossaryCandidate {
  term: string;
  count: number;
  memory_ids: string[];
}

export interface GlossaryCandidates {
  tenant_id: string;
  candidates: GlossaryCandidate[];
  min_count: number;
}
