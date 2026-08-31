/** Standalone BFF bridge: same-origin /api + /v1 fetch helpers, bearer
 * auth, CSRF session token, and the standalone bootstrap hook. */

export let apiBase = ''
export let tokenProvider: (() => Promise<string | undefined>) | undefined
export let overlayRoot: ShadowRoot | null = null
/** SEC-UI-01: process-scoped CSRF session token, fetched once at startup and
 * echoed back on every state-changing /api request (x-csrf-token). */
export let csrfToken: string | undefined
export let csrfFetch: Promise<string | undefined> | undefined

export function setStandaloneBridge(options: {
  base: string
  token: () => Promise<string | undefined>
  overlay?: ShadowRoot
}): void {
  apiBase = options.base
  tokenProvider = options.token
  overlayRoot = options.overlay ?? null
  // Fetch the CSRF session token right away so the first write never has to
  // wait on it (cached for the lifetime of this page).
  void ensureCsrfToken()
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await tokenProvider?.()
  return token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {}
}

/** Lazily fetch and cache the CSRF session token (same-origin, bearer-auth). */
export async function ensureCsrfToken(): Promise<string | undefined> {
  if (csrfToken !== undefined) return csrfToken
  if (csrfFetch === undefined) {
    csrfFetch = (async () => {
      try {
        const response = await fetch(`${base()}/api/session/csrf`, {
          headers: { ...(await authHeaders()), accept: 'application/json' },
        })
        if (!response.ok) return undefined
        const payload = (await response.json()) as { csrf_token?: unknown }
        csrfToken = typeof payload.csrf_token === 'string' ? payload.csrf_token : undefined
        return csrfToken
      } catch {
        return undefined
      }
    })()
  }
  return csrfFetch
}

export function base(): string {
  return apiBase
}


export async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  const result = await apiResult<T>(path, init)
  return result.ok ? result.data : null
}

/** Kernel error envelope (server.ts errorEnvelope — stable error codes,
 *  api-contracts §1). Kept structural so the intake wizard can surface the
 *  machine code without depending on the kernel package. */
export interface ApiErrorEnvelope {
  code?: string
  message?: string
  key?: string
  request_id?: string
  retryable?: boolean
}

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: ApiErrorEnvelope; status: number }

/**
 * Like api() but returns the parsed error envelope instead of collapsing to
 * null (ONBOARD-01 intake wizard needs the stable error code for copy).
 * 401 (unauthorized) still resolves as an envelope.
 */
export async function apiResult<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const isWrite = method !== 'GET' && method !== 'HEAD'
  // Reads may be retried once. Writes are not automatically replayed because
  // many kernel mutations use CAS rather than an Idempotency-Key.
  const attempts = isWrite ? 1 : 2
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${base()}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          accept: 'application/json',
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(await authHeaders()),
          ...(isWrite ? { 'x-csrf-token': (await ensureCsrfToken()) ?? '' } : {}),
        },
      })
      if (!response.ok) {
        let error: ApiErrorEnvelope = {}
        try {
          const payload = (await response.json()) as { error?: unknown }
          const e = typeof payload?.error === 'object' && payload.error !== null ? payload.error as Record<string, unknown> : {}
          error = {
            code: typeof e.code === 'string' ? e.code : undefined,
            message: typeof e.message === 'string' ? e.message : undefined,
            key: typeof e.key === 'string' ? e.key : undefined,
            request_id: typeof e.request_id === 'string' ? e.request_id : undefined,
            retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined,
          }
        } catch { /* non-JSON error body */ }
        if (error.code === undefined) {
          error = { code: response.status === 401 ? 'unauthorized' : 'http_error', message: `HTTP ${response.status}` }
        }
        return { ok: false, error, status: response.status }
      }
      return { ok: true, data: (await response.json()) as T, status: response.status }
    } catch {
      if (init?.signal?.aborted === true) break
      // retry once on transport failures
    }
  }
  return { ok: false, error: { code: 'network_error', message: 'request failed' }, status: 0 }
}

/**
 * UPLOAD-01 multipart passthrough: FormData with the BROWSER-set boundary
 * (never a JSON content-type — the BFF/kernel parse the real multipart
 * envelope). Same bearer/CSRF semantics as apiResult.
 */
export async function apiMultipart<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  const method = 'POST'
  // Multipart uploads are state-changing POSTs. A transport error does not
  // prove the server did not commit, so automatic replay is unsafe.
  for (let attempt = 0; attempt < 1; attempt++) {
    try {
      const response = await fetch(`${base()}${path}`, {
        method,
        body: form,
        headers: {
          accept: 'application/json',
          ...(await authHeaders()),
          'x-csrf-token': (await ensureCsrfToken()) ?? '',
        },
      })
      if (!response.ok) {
        let error: ApiErrorEnvelope = {}
        try {
          const payload = (await response.json()) as { error?: unknown }
          const e = typeof payload?.error === 'object' && payload.error !== null ? payload.error as Record<string, unknown> : {}
          error = {
            code: typeof e.code === 'string' ? e.code : undefined,
            message: typeof e.message === 'string' ? e.message : undefined,
            key: typeof e.key === 'string' ? e.key : undefined,
            retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined,
          }
        } catch { /* non-JSON error body */ }
        if (error.code === undefined) error = { code: 'http_error', message: `HTTP ${response.status}` }
        return { ok: false, error, status: response.status }
      }
      return { ok: true, data: (await response.json()) as T, status: response.status }
    } catch { /* caller may retry explicitly after reconciling server state */ }
  }
  return { ok: false, error: { code: 'network_error', message: 'request failed' }, status: 0 }
}
