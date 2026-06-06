/**
 * Shared TypeScript domain types for the PetroBrain frontends.
 *
 * The authoritative wire schemas live in the FastAPI app at
 * ``app/models/schemas.py`` and are exposed via OpenAPI. ``@petrobrain/api``
 * generates strongly-typed wire types from that schema; this package holds
 * the domain types the UI cares about - Principal claims decoded from the
 * JWT, citation shape, confidence labels, tool-result shapes used by the
 * chat UI - i.e. things the OpenAPI client can't express directly.
 */

export type Role = 'platform_admin' | 'admin' | 'engineer' | 'field' | 'hse';

export type Module = 'general' | 'research' | 'well_control' | 'emissions_mrv' | 'ptw';

export interface Principal {
  tenantId: string;
  userId: string;
  email?: string;
  role: Role;
  allowedAssets: string[];
}

export interface Citation {
  source_id?: string | null;
  title: string | null;
  revision: string | null;
  clause: string | null;
  /**
   * Source URL for web-sourced citations (Tavily). Absent / null for citations
   * pulled from the tenant's RAG corpus (those reference document + clause
   * inside the system instead of an external page).
   */
  url?: string | null;
  reliability?: 'primary' | 'high' | 'medium' | 'low' | 'unknown' | null;
  freshness?: 'current' | 'dated' | 'unknown' | null;
}

export interface ToolResult<TInput = unknown, TOutput = unknown> {
  tool: string;
  input: TInput;
  result: TOutput;
}

export interface EvidenceSource {
  type: 'document' | 'web' | string;
  label: string;
  url?: string | null;
}

export interface EvidenceCalculation {
  label: string;
  outputs: Array<{ label: string; value: string | number | boolean }>;
  formulas: string[];
}

export interface EvidencePack {
  confidence: { label: string; reason: string };
  checked: string[];
  not_verified: string[];
  sources: EvidenceSource[];
  calculations: EvidenceCalculation[];
  safety: { requires_human_verification: boolean; message: string };
}

export type ConfidenceLabel = 'high' | 'medium' | 'low' | 'unknown';

export interface ConfidenceSignal {
  label: ConfidenceLabel;
  reason?: string;
}

export interface ChatStreamEvent {
  event: 'token' | 'tool_call' | 'tool_result' | 'citation' | 'flag' | 'done';
  data: Record<string, unknown>;
}

export type AssetType = 'field' | 'block' | 'train' | 'equipment' | string;

export interface AssetNode {
  id: string;
  tenantId: string;
  parentId: string | null;
  type: AssetType;
  name: string;
  attributes: Record<string, unknown>;
}
