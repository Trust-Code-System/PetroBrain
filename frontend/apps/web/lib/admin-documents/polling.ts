import { TERMINAL_STATUSES, type AdminDocumentRow } from './types.js';

/**
 * Polling cadence rule (B3): React Query keeps ``GET /admin/documents``
 * warm at 5 s while any row is still moving through the state machine.
 * Returns ``false`` once everything has settled (done | failed) so the
 * client goes quiet - important on slow networks and for not piling up
 * audit_events rows in the backend.
 */
export const POLL_INTERVAL_MS = 5_000;

export function shouldKeepPolling(rows: AdminDocumentRow[]): false | number {
  if (rows.length === 0) return false;
  const moving = rows.some((row) => !TERMINAL_STATUSES.has(row.status));
  return moving ? POLL_INTERVAL_MS : false;
}
