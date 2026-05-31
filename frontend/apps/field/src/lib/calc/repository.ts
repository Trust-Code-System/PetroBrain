/**
 * Recent calc results - local SQLite, capped at 50 rows per tenant.
 *
 * Save / list / get / delete. The cap is enforced on insert: after each
 * save we trim everything older than the 50th row for the tenant. This
 * matches the roadmap requirement (last 50 results stored locally for
 * offline reference).
 */
import { getDb } from '../cache/database.js';
import type { CalcResponse, RecentCalc, RecentCalcRow } from './types.js';
import type { CalcFormState } from './request.js';

const MAX_PER_TENANT = 50;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `calc-${Date.now()}-${idCounter}`;
}

export async function saveRecentCalc(input: {
  tenant_id: string;
  user_id: string;
  form: CalcFormState;
  response: CalcResponse;
}): Promise<RecentCalc> {
  const db = await getDb();
  const id = nextId();
  const now = new Date().toISOString();
  const inputs: Record<string, { value: number; unit: string }> = {};
  for (const [name, value] of Object.entries(input.response.result.inputs)) {
    inputs[name] = {
      value,
      unit: input.form[name]?.unit ?? input.response.submitted_units[name] ?? '',
    };
  }
  await db.runAsync(
    `INSERT INTO calc_results (id, tenant_id, user_id, calc_name, family, inputs_json, result_json, created_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.tenant_id,
    input.user_id,
    input.response.calc,
    input.response.family,
    JSON.stringify(inputs),
    JSON.stringify(input.response.result),
    now,
  );
  await trimOldRows(input.tenant_id);
  const row: RecentCalc = {
    id,
    calc_name: input.response.calc,
    family: input.response.family,
    inputs,
    result: input.response.result,
    created_utc: now,
  };
  return row;
}

export async function listRecentCalcs(tenantId: string): Promise<RecentCalc[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RecentCalcRow>(
    `SELECT * FROM calc_results WHERE tenant_id = ? ORDER BY created_utc DESC LIMIT ?`,
    tenantId,
    MAX_PER_TENANT,
  );
  return rows.map(rowToRecent);
}

export async function getRecentCalc(tenantId: string, id: string): Promise<RecentCalc | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<RecentCalcRow>(
    'SELECT * FROM calc_results WHERE tenant_id = ? AND id = ?',
    tenantId,
    id,
  );
  return row ? rowToRecent(row) : null;
}

export async function clearRecentCalcs(tenantId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM calc_results WHERE tenant_id = ?', tenantId);
}

async function trimOldRows(tenantId: string): Promise<void> {
  const db = await getDb();
  // Keep the most recent MAX_PER_TENANT; delete everything older for
  // this tenant. SQLite doesn't support DELETE ... LIMIT directly, so
  // we use a subquery to identify the IDs to keep.
  await db.runAsync(
    `DELETE FROM calc_results
     WHERE tenant_id = ? AND id NOT IN (
       SELECT id FROM calc_results
       WHERE tenant_id = ?
       ORDER BY created_utc DESC
       LIMIT ?
     )`,
    tenantId,
    tenantId,
    MAX_PER_TENANT,
  );
}

function rowToRecent(row: RecentCalcRow): RecentCalc {
  return {
    id: row.id,
    calc_name: row.calc_name,
    family: row.family,
    inputs: JSON.parse(row.inputs_json) as RecentCalc['inputs'],
    result: JSON.parse(row.result_json) as RecentCalc['result'],
    created_utc: row.created_utc,
  };
}

export { MAX_PER_TENANT };
