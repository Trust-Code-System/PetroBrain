export interface AuditEvent {
  id: string;
  ts: string;
  tenant_id: string;
  user_id: string;
  role: string;
  action: string;
  module: string;
  flags: string[];
  usage: Record<string, unknown>;
}

export interface AdminNotification {
  notification_id: string;
  title: string;
  message: string;
  category: string;
  severity: string;
  status: string;
  user_id?: string | null;
  user_name?: string | null;
  user_role?: string | null;
  related_module?: string | null;
  triggered_rule?: string | null;
  created_at: string;
}

interface Auth { baseUrl: string; token: string; signal?: AbortSignal }

async function get<T>(auth: Auth, path: string): Promise<T> {
  const response = await fetch(`${auth.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    ...(auth.signal ? { signal: auth.signal } : {}),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function listAudit(auth: Auth, query = '') {
  return get<{ events: AuditEvent[]; count: number }>(auth, `/admin/audit${query}`);
}

export function listNotifications(auth: Auth, query = '') {
  return get<{ notifications: AdminNotification[]; count: number }>(auth, `/admin/notifications${query}`);
}

export function listAdminTasks(auth: Auth, overdue = false) {
  return get<{ tasks: import('../tasks/types').PetroTask[]; count: number }>(auth, `/admin/tasks${overdue ? '/overdue' : ''}`);
}

export async function updateNotification(auth: Auth, id: string, action: 'acknowledge' | 'resolve') {
  const response = await fetch(`${auth.baseUrl}/admin/notifications/${id}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<AdminNotification>;
}
