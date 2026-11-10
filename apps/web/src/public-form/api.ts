import type {
  GrantDto,
  GrantOffsetDto,
  PublicFormDto,
  SubmissionCompleteDto,
  SubmissionStartResultDto,
  SubmissionStatusDto,
} from '@aom/shared/forms';

/** An error answer of the public routes: a code, a sentence and what the page may do next. */
export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly fields: Array<{ field: string; code: string }> = [],
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = 'PublicApiError';
  }
}

async function call<T>(method: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // No cookie is sent: the public API ignores sessions.
    res = await fetch(`/api/public/forms/${path}`, { method, credentials: 'omit', ...init });
  } catch {
    throw new PublicApiError(0, 'network', 'The connection was lost.', true);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = json?.error;
    throw new PublicApiError(
      res.status,
      typeof e?.code === 'string' ? e.code : 'http_error',
      typeof e?.message === 'string' ? e.message : 'The request failed.',
      e?.retryable === true || res.status === 0,
      Array.isArray(e?.fields) ? e.fields : [],
      Number(res.headers.get('retry-after')) || 0,
    );
  }
  return json as T;
}

const jsonInit = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  headers: { 'content-type': 'application/json', accept: 'application/json', ...extra },
  body: JSON.stringify(body),
});

export const publicApi = {
  load: (publicId: string, link?: string) =>
    call<PublicFormDto>('GET', publicId, {
      headers: { accept: 'application/json', ...(link ? { 'x-form-link': link } : {}) },
    }),
  /** The runner is offline: the client leaves an email address for the secure link. Never the answers or files. */
  offlineRequest: (publicId: string, body: unknown) =>
    call<{ status: 'pending' }>('POST', `${publicId}/offline-requests`, jsonInit(body)),
  start: (publicId: string, body: unknown) =>
    call<SubmissionStartResultDto>('POST', `${publicId}/submissions`, jsonInit(body)),
  putPart: (publicId: string, sid: string, index: number, file: File, token: string) =>
    call<{ state: 'stored' }>('PUT', `${publicId}/submissions/${sid}/parts/${index}`, {
      headers: {
        'content-type': 'application/octet-stream',
        'x-upload-token': token,
        'x-file-name': encodeURIComponent(file.name),
      },
      body: file,
    }),
  grant: (publicId: string, sid: string, index: number, token: string, fileName = '') =>
    call<GrantDto>(
      'POST',
      `${publicId}/submissions/${sid}/parts/${index}/grant`,
      jsonInit({}, { 'x-upload-token': token, 'x-file-name': encodeURIComponent(fileName) }),
    ),
  grantOffset: (publicId: string, sid: string, index: number, token: string) =>
    call<GrantOffsetDto>('GET', `${publicId}/submissions/${sid}/parts/${index}/grant`, {
      headers: { accept: 'application/json', 'x-upload-token': token },
    }),
  grantComplete: (
    publicId: string,
    sid: string,
    index: number,
    token: string,
    body: { size: number; sha256: string; providerId?: string; etag?: string },
  ) =>
    call<{ state: 'verifying' | 'stored' }>(
      'POST',
      `${publicId}/submissions/${sid}/parts/${index}/grant/complete`,
      jsonInit(body, { 'x-upload-token': token }),
    ),
  grantCancel: (
    publicId: string,
    sid: string,
    index: number,
    token: string,
    reason: 'retry' | 'blocked' | 'abandoned',
  ) =>
    call<{ state: string }>(
      'POST',
      `${publicId}/submissions/${sid}/parts/${index}/grant/cancel`,
      jsonInit({ reason }, { 'x-upload-token': token }),
    ),
  status: (publicId: string, sid: string, token: string) =>
    call<SubmissionStatusDto>('GET', `${publicId}/submissions/${sid}`, {
      headers: { accept: 'application/json', 'x-upload-token': token },
    }),
  complete: (publicId: string, sid: string, token: string, answers: unknown) =>
    call<SubmissionCompleteDto>(
      'POST',
      `${publicId}/submissions/${sid}/complete`,
      jsonInit({ answers }, { 'x-upload-token': token }),
    ),
};
