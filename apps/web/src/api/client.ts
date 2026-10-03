import type { ZodType } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Same-origin JSON fetch with the session cookie. Mutations are JSON-only (server rejects other content types) and
 * the browser sends `Origin` itself. Responses are zod-parsed in dev builds only (docs/ARCHITECTURE.md section 21).
 */
export async function api<T>(method: Method, path: string, body?: unknown, schema?: ZodType<T>): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: { accept: 'application/json' } };
  if (method !== 'GET' && method !== 'DELETE') {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
      err?.details,
    );
  }
  if (schema && import.meta.env.DEV) {
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      console.warn(`[api] ${method} ${path} response does not match schema`, parsed.error.issues);
  }
  return json as T;
}

export const get = <T>(path: string, schema?: ZodType<T>) => api<T>('GET', path, undefined, schema);
export const post = <T>(path: string, body?: unknown, schema?: ZodType<T>) =>
  api<T>('POST', path, body, schema);
export const patch = <T>(path: string, body?: unknown, schema?: ZodType<T>) =>
  api<T>('PATCH', path, body, schema);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
