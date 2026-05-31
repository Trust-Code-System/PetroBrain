/**
 * Local PTW persistence (SQLite).
 *
 * Save / list / get / sign / queue-for-sync. Every row is tenant-scoped;
 * sign-offs append to the JSON ``signatures`` column with a timestamp.
 *
 * Sync to backend is a placeholder - see ``app/(tabs)/logs.tsx`` for the
 * queue surface and ``src/lib/cache/sync.ts`` for the TODO contract.
 */
import { getDb } from '../cache/database.js';
import type {
  GeneratedPermit,
  PermitSignature,
  PtwFormState,
  SavedPermit,
} from './types.js';

interface PermitRow {
  id: string;
  tenant_id: string;
  user_id: string;
  format: 'permit' | 'toolbox_talk';
  status: 'draft_unsigned' | 'signed';
  created_utc: string;
  updated_utc: string;
  form_json: string;
  generated_json: string;
  signatures_json: string;
}

export async function savePermit(input: {
  id?: string;
  tenant_id: string;
  user_id: string;
  form: PtwFormState;
  generated: GeneratedPermit;
}): Promise<SavedPermit> {
  const db = await getDb();
  const now = new Date().toISOString();
  const id = input.id ?? input.generated.permit_id;

  // Update existing permits in place so an edit-then-save round-trip
  // doesn't proliferate rows. INSERT-or-REPLACE keeps the user_id
  // honest if the same draft is touched by multiple signed-in users.
  await db.runAsync(
    `INSERT INTO permits (id, tenant_id, user_id, format, status, created_utc, updated_utc, form_json, generated_json, signatures_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       updated_utc = excluded.updated_utc,
       form_json = excluded.form_json,
       generated_json = excluded.generated_json,
       status = excluded.status`,
    id,
    input.tenant_id,
    input.user_id,
    input.generated.format,
    'draft_unsigned',
    now,
    now,
    JSON.stringify(input.form),
    JSON.stringify(input.generated),
    '[]',
  );
  const row = await getPermitRow(input.tenant_id, id);
  if (!row) throw new Error('permit row vanished after insert');
  return rowToSavedPermit(row);
}

export async function listPermits(tenantId: string): Promise<SavedPermit[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PermitRow>(
    'SELECT * FROM permits WHERE tenant_id = ? ORDER BY updated_utc DESC',
    tenantId,
  );
  return rows.map(rowToSavedPermit);
}

export async function getPermit(tenantId: string, id: string): Promise<SavedPermit | null> {
  const row = await getPermitRow(tenantId, id);
  return row ? rowToSavedPermit(row) : null;
}

export async function deletePermit(tenantId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM permits WHERE tenant_id = ? AND id = ?', tenantId, id);
}

export async function addSignature(
  tenantId: string,
  id: string,
  signature: PermitSignature,
): Promise<SavedPermit> {
  const db = await getDb();
  const row = await getPermitRow(tenantId, id);
  if (!row) throw new Error('permit not found');
  const signatures: PermitSignature[] = JSON.parse(row.signatures_json) as PermitSignature[];
  signatures.push(signature);
  await db.runAsync(
    `UPDATE permits SET signatures_json = ?, updated_utc = ?, status = ?
     WHERE tenant_id = ? AND id = ?`,
    JSON.stringify(signatures),
    new Date().toISOString(),
    'signed',
    tenantId,
    id,
  );
  const updated = await getPermitRow(tenantId, id);
  if (!updated) throw new Error('permit vanished after signature');
  return rowToSavedPermit(updated);
}

export async function queuePermitForSync(permit: SavedPermit): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO outgoing_queue (tenant_id, kind, payload_json, queued_utc)
     VALUES (?, ?, ?, ?)`,
    permit.tenant_id,
    'permit',
    JSON.stringify(permit),
    new Date().toISOString(),
  );
}

async function getPermitRow(tenantId: string, id: string): Promise<PermitRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<PermitRow>(
    'SELECT * FROM permits WHERE tenant_id = ? AND id = ?',
    tenantId,
    id,
  );
  return row ?? null;
}

function rowToSavedPermit(row: PermitRow): SavedPermit {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    format: row.format,
    status: row.status,
    created_utc: row.created_utc,
    updated_utc: row.updated_utc,
    form: JSON.parse(row.form_json) as PtwFormState,
    generated: JSON.parse(row.generated_json) as GeneratedPermit,
    signatures: JSON.parse(row.signatures_json) as PermitSignature[],
  };
}
