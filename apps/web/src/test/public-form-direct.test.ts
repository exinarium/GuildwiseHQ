import { describe, expect, it } from 'vitest';
import { directUploadsLine } from '../lib/storage.ts';
import { DirectBlockedError, DirectExpiredError, directUpload } from '../public-form/direct-upload.ts';
import { describePublicError } from '../public-form/messages.ts';

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  size: number;
}

/** A scripted XMLHttpRequest: each request gets the next answer, or fails like a network error. */
function fakeXhr(
  answers: Array<{ status: number; body?: string; range?: string; etag?: string } | 'network' | 'dropped'>,
) {
  const reqs: Req[] = [];
  const make = () => {
    const x: any = {
      upload: {} as any,
      headers: {} as Record<string, string>,
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      },
      setRequestHeader(k: string, v: string) {
        this.headers[k.toLowerCase()] = v;
      },
      getResponseHeader(k: string) {
        const a = this.answer;
        return k === 'range' ? (a.range ?? null) : k === 'etag' ? (a.etag ?? null) : null;
      },
      send(blob: Blob) {
        reqs.push({ method: this.method, url: this.url, headers: { ...this.headers }, size: blob.size });
        const a = answers.shift();
        queueMicrotask(() => {
          if (a === 'dropped') {
            this.upload.onprogress?.({ loaded: Math.floor(blob.size / 2) });
            return this.onerror();
          }
          if (a === undefined || a === 'network') return this.onerror();
          this.answer = a;
          this.status = a.status;
          this.responseText = a.body ?? '';
          this.upload.onprogress?.({ loaded: blob.size });
          this.onload();
        });
      },
    };
    return x as XMLHttpRequest;
  };
  return { make, reqs };
}

const grant = (chunkBytes: number | null) => ({
  method: 'PUT' as const,
  url: 'https://up.example.com/session/abc',
  headers: { 'if-none-match': '*', 'content-type': 'application/pdf' },
  chunkBytes,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const file = (n: number) => new File([new Uint8Array(n)], 'a.pdf', { type: 'application/pdf' });
const noWait = async () => undefined;

describe('direct upload to the provider', () => {
  it('sends chunks with Content-Range, reports progress and returns the provider id', async () => {
    const x = fakeXhr([{ status: 202 }, { status: 202 }, { status: 201, body: '{"id":"ITEM1"}' }]);
    const seen: number[] = [];
    const r = await directUpload(file(25), grant(10), {
      xhr: x.make,
      wait: noWait,
      offset: async () => null,
      onProgress: (n) => seen.push(n),
    });
    expect(r).toEqual({ providerId: 'ITEM1' });
    expect(x.reqs.map((q) => q.headers['content-range'])).toEqual([
      'bytes 0-9/25',
      'bytes 10-19/25',
      'bytes 20-24/25',
    ]);
    expect(x.reqs.every((q) => q.url === 'https://up.example.com/session/abc')).toBe(true);
    expect(seen.at(-1)).toBe(25);
  });

  it('sends an S3 file in one PUT with only the headers of the grant', async () => {
    const x = fakeXhr([{ status: 200, etag: '"abc123"' }]);
    const r = await directUpload(file(40), grant(null), {
      xhr: x.make,
      wait: noWait,
      offset: async () => null,
      onProgress: () => undefined,
    });
    expect(r).toEqual({ etag: 'abc123' });
    expect(x.reqs).toHaveLength(1);
    expect(x.reqs[0]?.headers).toEqual({ 'if-none-match': '*', 'content-type': 'application/pdf' });
    expect(x.reqs[0]?.size).toBe(40);
  });

  it('resumes from the offset after a dropped chunk', async () => {
    const x = fakeXhr([{ status: 202 }, 'network', { status: 202 }, { status: 200, body: '{"id":"I"}' }]);
    const r = await directUpload(file(30), grant(10), {
      xhr: x.make,
      wait: noWait,
      offset: async () => 10,
      onProgress: () => undefined,
    });
    expect(r).toEqual({ providerId: 'I' });
    expect(x.reqs.map((q) => q.headers['content-range'])).toEqual([
      'bytes 0-9/30',
      'bytes 10-19/30',
      'bytes 10-19/30',
      'bytes 20-29/30',
    ]);
  });

  it('asks for a new grant when the provider lost the upload or the offset is gone', async () => {
    await expect(
      directUpload(file(30), grant(10), {
        xhr: fakeXhr([{ status: 202 }, { status: 404 }]).make,
        wait: noWait,
        offset: async () => null,
        onProgress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(DirectExpiredError);
    await expect(
      directUpload(file(30), grant(10), {
        xhr: fakeXhr([{ status: 202 }, 'network']).make,
        wait: noWait,
        offset: async () => null,
        onProgress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(DirectExpiredError);
  });

  it('an expired or reused S3 address is a rejection, not a retry loop', async () => {
    const x = fakeXhr([{ status: 403 }]);
    await expect(
      directUpload(file(10), grant(null), {
        xhr: x.make,
        wait: noWait,
        offset: async () => null,
        onProgress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(DirectExpiredError);
    expect(x.reqs).toHaveLength(1);
  });

  it('a first request with no answer at all (page rules or CORS) is "blocked"', async () => {
    const x = fakeXhr(['network']);
    await expect(
      directUpload(file(10), grant(10), {
        xhr: x.make,
        wait: noWait,
        offset: async () => 0,
        onProgress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(DirectBlockedError);
    expect(x.reqs).toHaveLength(1);
  });
  it('a drop after bytes were accepted on the first request is an interruption and resumes, not "blocked"', async () => {
    const x = fakeXhr(['dropped', { status: 200, etag: '"E"' }]);
    const r = await directUpload(file(10), grant(null), {
      xhr: x.make,
      wait: noWait,
      offset: async () => 0,
      onProgress: () => undefined,
    });
    expect(r).toEqual({ etag: 'E' });
    expect(x.reqs).toHaveLength(2);
  });
});

describe('what the page says', () => {
  it('has a message for an unavailable upload and for a refused content type', () => {
    expect(describePublicError({ code: 'upload_unavailable', status: 503, retryable: true }).retry).toBe(
      true,
    );
    const final = describePublicError({ code: 'upload_unavailable', status: 502, retryable: false });
    expect(final.retry).toBe(false);
    expect(final.text).toMatch(/contact the firm/);
    expect(describePublicError({ code: 'upload_mode', status: 409, retryable: false }).text).toMatch(
      /reload/,
    );
  });
});

describe('the storage settings line', () => {
  const base: any = { directUploads: null };
  it('shows nothing for folders and vaults, ready for a working cloud storage, and the reason otherwise', () => {
    expect(directUploadsLine(base)).toBeNull();
    expect(directUploadsLine({ directUploads: { state: 'ready', reason: null } } as any)).toBe(
      'Public form files: ready',
    );
    expect(
      directUploadsLine({ directUploads: { state: 'unavailable', reason: 'cors_missing' } } as any),
    ).toMatch(/not possible.*CORS/);
    expect(
      directUploadsLine({ directUploads: { state: 'unavailable', reason: 'http_endpoint' } } as any),
    ).toMatch(/https/);
  });
});
