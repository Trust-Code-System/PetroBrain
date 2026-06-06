import type { PetroTask, TaskCreateInput, TaskListResponse } from './types';

interface Auth {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
}

async function request<T>(auth: Auth, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${auth.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    ...(auth.signal ? { signal: auth.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export function listTasks(auth: Auth, query = '') {
  return request<TaskListResponse>(auth, `/tasks${query}`);
}

export function createTask(auth: Auth, input: TaskCreateInput) {
  return request<PetroTask>(auth, '/tasks', { method: 'POST', body: JSON.stringify(input) });
}

export function taskAction(auth: Auth, taskId: string, action: 'complete' | 'pause' | 'resume') {
  return request<PetroTask>(auth, `/tasks/${taskId}/${action}`, { method: 'POST' });
}
