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
