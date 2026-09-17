'use client';

import { ErrorCode, type ErrorCodeValue } from '@bizbot/shared';

/**
 * The API client.
 *
 * Holds the access token in memory only — never localStorage, where any injected script
 * can read it. The refresh token lives in an httpOnly cookie the browser sends
 * automatically, so a page reload silently restores the session without exposing
 * anything to JavaScript (docs/architecture/10-security.md).
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCodeValue | string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages, for rendering next to the inputs that caused them. */
  get fieldErrors(): Record<string, string> {
    const fields = this.details?.fields;
    if (!Array.isArray(fields)) return {};
    return Object.fromEntries(
      fields.map((f: { path?: string; message?: string }) => [f.path ?? '', f.message ?? '']),
    );
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  tenantId?: string;
  /** Skip the refresh-and-retry dance; used by the refresh call itself. */
  raw?: boolean;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, tenantId, raw, headers, ...rest } = options;

  const response = await fetch(`${BASE}${path}`, {
    ...rest,
    // Sends the refresh cookie; without this a reload logs the user out.
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'accept-language':
        typeof document !== 'undefined' ? document.documentElement.lang || 'uz' : 'uz',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...(headers as Record<string, string>),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // An expired access token is the common case, not an error: refresh once and retry.
  // Concurrent 401s share one refresh so a page with six widgets does not fire six.
  if (response.status === 401 && !raw) {
    const payload = await response
      .clone()
      .json()
      .catch(() => null);
    const code = payload?.error?.code;
    if (code === ErrorCode.TOKEN_EXPIRED || code === ErrorCode.UNAUTHENTICATED) {
      const refreshed = await refreshSession();
      if (refreshed) return api<T>(path, { ...options, raw: true });
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      error.code ?? 'INTERNAL',
      error.message ?? 'Xatolik yuz berdi',
      response.status,
      error.details,
      error.requestId,
    );
  }

  return payload as T;
}

export async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { accessToken?: string };
      if (!payload.accessToken) return false;
      setAccessToken(payload.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this one all see the same result.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();

  return refreshPromise;
}

/** SWR fetcher. Accepts `[path, tenantId]` so a key changes when the business changes. */
export const fetcher = <T>(key: string | [string, string | undefined]): Promise<T> => {
  const [path, tenantId] = Array.isArray(key) ? key : [key, undefined];
  return api<T>(path, { tenantId });
};
