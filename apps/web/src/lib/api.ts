import type { ApiErrorBody, SessionDto } from '@socialpilot/shared';

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
    public details?: unknown,
  ) {
    super(message);
  }
}

// Access token lives only in memory; the refresh token is an httpOnly cookie the browser JS never sees.
let accessToken: string | null = null;
let onSessionChange: (s: SessionDto | null) => void = () => undefined;
let refreshing: Promise<SessionDto | null> | null = null;

export const setSessionListener = (fn: (s: SessionDto | null) => void) => (onSessionChange = fn);
export function setSession(s: SessionDto | null) {
  accessToken = s?.accessToken ?? null;
  onSessionChange(s);
}

async function raw<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-requested-with', 'socialpilot');
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as ApiErrorBody).error ?? { code: 'http_error', message: res.statusText };
    const fields = (e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {};
    throw new ApiError(res.status, e.code, e.message, fields, e.details);
  }
  return body as T;
}

/** Exchange the refresh cookie for a new access token (deduplicated across concurrent callers). */
export function refreshSession(): Promise<SessionDto | null> {
  if (!refreshing) {
    refreshing = raw<{ data: SessionDto }>('/v1/auth/refresh', { method: 'POST' })
      .then((r) => {
        setSession(r.data);
        return r.data;
      })
      .catch(() => {
        setSession(null);
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  try {
    return await raw<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !path.startsWith('/v1/auth/')) {
      const s = await refreshSession();
      if (s) return raw<T>(path, init);
    }
    throw err;
  }
}

export const get = <T>(path: string) => api<{ data: T }>(path).then((r) => r.data);
export const getPage = <T>(path: string) => api<{ data: T; meta: { page: number; pageSize: number; total: number } }>(path);
export const post = <T>(path: string, json?: unknown) => api<{ data: T }>(path, { method: 'POST', json: json ?? {} }).then((r) => r?.data);
export const patch = <T>(path: string, json: unknown) => api<{ data: T }>(path, { method: 'PATCH', json }).then((r) => r.data);
export const del = (path: string) => api<void>(path, { method: 'DELETE' });

/** Authenticated file download (CSV exports). */
export async function downloadFile(path: string, filename: string) {
  const run = () => fetch(`${BASE}${path}`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {}, credentials: 'include' });
  let res = await run();
  if (res.status === 401 && (await refreshSession())) res = await run();
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
