export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token && token.length > 8 ? token : null;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;

  if (options.body !== undefined) {
    if (
      typeof options.body === 'object' &&
      options.body !== null &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof Blob) &&
      !(options.body instanceof URLSearchParams)
    ) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    } else {
      body = options.body as BodyInit;
    }
  }
  if (!SAFE_METHODS.has(method) && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'network_error');
  }

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const record = (payload || {}) as { code?: string; message?: string };
    throw new ApiError(
      response.status,
      record.code || 'request_failed',
      record.message || record.code,
    );
  }
  if (payload && typeof payload === 'object' && 'csrfToken' in payload) {
    const token = (payload as { csrfToken?: string }).csrfToken;
    if (token) setCsrfToken(token);
  }
  return payload as T;
}

export function apiPath(
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}
