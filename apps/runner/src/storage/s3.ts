import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { STORAGE_MAX_CLASH, storageClashName, storedPathSegments } from '@aom/shared';
import { fromHttp } from './errors.ts';
import { presignV4, signV4, uriEncode } from './s3-sign.ts';
import type { DirectUnavailableReason } from '@aom/shared';
import {
  type DirectCapable,
  type DirectGrant,
  type FetchLike,
  PROBE_BODY,
  PROBE_NAME,
  type Spooled,
  type StagedInfo,
  STAGING_FOLDER,
  type StorageConnector,
  StorageError,
  type StorageTarget,
} from './types.ts';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
}
export interface S3Keys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|[^.]+$)/i;

/** `http://` is allowed only for a loopback or private address (MinIO on the LAN). */
export function checkS3Endpoint(endpoint: string): URL {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new StorageError('invalid', 'The endpoint is not a valid address.');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && PRIVATE_HOST.test(u.hostname)))
    throw new StorageError(
      'invalid',
      'The endpoint must use https (http is allowed only on a private network).',
    );
  return u;
}

/** S3-compatible object storage (AWS, MinIO, Backblaze, Wasabi, R2...). */
export class S3Connector implements StorageConnector, DirectCapable {
  constructor(
    private readonly cfg: S3Config,
    private readonly keys: S3Keys,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private url(key: string): { url: string; host: string; path: string } {
    const u = checkS3Endpoint(this.cfg.endpoint);
    const enc = uriEncode(key, true);
    const base = u.pathname.replace(/\/$/, '');
    if (this.cfg.pathStyle || u.hostname === 'localhost' || /^[\d.]+$/.test(u.hostname)) {
      const path = `${base}/${this.cfg.bucket}/${enc}`;
      return { url: `${u.protocol}//${u.host}${path}`, host: u.host, path };
    }
    const host = `${this.cfg.bucket}.${u.host}`;
    const path = `${base}/${enc}`;
    return { url: `${u.protocol}//${host}${path}`, host, path };
  }

  private async call(
    method: 'PUT' | 'HEAD' | 'DELETE' | 'GET',
    key: string,
    signal: AbortSignal,
    payloadHash: string,
    body?: RequestInit['body'],
    extra: Record<string, string> = {},
    query?: Record<string, string>,
  ): Promise<Response> {
    const { url: base, host, path } = this.url(key);
    const qs = query
      ? `?${Object.entries(query)
          .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
          .join('&')}`
      : '';
    const url = `${base}${qs}`;
    const headers = signV4({
      method,
      host,
      path,
      ...(query ? { query } : {}),
      headers: extra,
      payloadHash,
      region: this.cfg.region,
      ...this.keys,
      now: this.now(),
    });
    try {
      return await this.fetchFn(url, {
        method,
        headers,
        ...(body !== undefined ? { body, duplex: 'half' } : {}),
        signal,
      } as RequestInit);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError')
        throw new StorageError('timeout', 'The storage did not answer in time.');
      throw new StorageError('unavailable', 'The storage could not be reached.');
    }
  }

  private async fail(res: Response): Promise<never> {
    let code: string | undefined;
    try {
      const text = await res.text();
      code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    } catch {
      // no body
    }
    throw fromHttp('s3', res.status, code);
  }

  private key(parts: string[]): string {
    return [this.cfg.prefix.replace(/^\/+|\/+$/g, ''), ...parts].filter(Boolean).join('/');
  }

  async probe(signal: AbortSignal): Promise<void> {
    const key = this.key([PROBE_NAME()]);
    const hash = createHash('sha256').update(PROBE_BODY).digest('hex');
    const put = await this.call('PUT', key, signal, hash, PROBE_BODY, { 'content-type': 'text/plain' });
    if (!put.ok) await this.fail(put);
    await put.arrayBuffer().catch(() => undefined);
    const del = await this.call('DELETE', key, signal, createHash('sha256').update('').digest('hex'));
    if (!del.ok && del.status !== 404) await this.fail(del);
  }

  async put(
    target: StorageTarget,
    file: Spooled,
    signal: AbortSignal,
  ): Promise<{ path: string; providerId?: string }> {
    const empty = createHash('sha256').update('').digest('hex');
    for (let n = 1; n <= STORAGE_MAX_CLASH; n++) {
      const name = n === 1 ? target.name : storageClashName(target.name, n);
      const key = this.key([...target.folder, name]);
      const head = await this.call('HEAD', key, signal, empty);
      if (head.status === 200) continue;
      if (head.status !== 404) await this.fail(head);
      const body = Readable.toWeb(createReadStream(file.file)) as unknown as RequestInit['body'];
      const res = await this.call('PUT', key, signal, file.sha256, body, {
        'content-type': file.contentType,
        'content-length': String(file.size),
      });
      if (!res.ok) await this.fail(res);
      await res.arrayBuffer().catch(() => undefined);
      const id =
        res.headers.get('x-amz-version-id') ?? res.headers.get('etag')?.replace(/"/g, '') ?? undefined;
      return { path: key, ...(id ? { providerId: id.slice(0, 300) } : {}) };
    }
    throw new StorageError('conflict', 'Too many files with the same name.');
  }

  async delete(path: string, signal: AbortSignal): Promise<void> {
    const res = await this.call('DELETE', path, signal, createHash('sha256').update('').digest('hex'));
    if (!res.ok && res.status !== 404) await this.fail(res);
  }

  async deleteFile(ref: { path: string }, signal: AbortSignal): Promise<'deleted' | 'not_found'> {
    const prefix = this.cfg.prefix.replace(/^\/+|\/+$/g, '');
    const segs = storedPathSegments(ref.path, prefix);
    if (!segs) throw new StorageError('invalid', 'The file is outside the storage destination.');
    const key = this.key(segs);
    const empty = createHash('sha256').update('').digest('hex');
    // S3 answers 204 for a missing key, so look first to tell "deleted" from "not there".
    const head = await this.call('HEAD', key, signal, empty);
    if (head.status === 404) return 'not_found';
    if (head.status !== 200) await this.fail(head);
    const del = await this.call('DELETE', key, signal, empty);
    if (del.status === 404) return 'not_found';
    if (!del.ok) await this.fail(del);
    await del.arrayBuffer().catch(() => undefined);
    return 'deleted';
  }

  // ------------------------------------------------------------------------------------------ direct uploads

  private stagingKey(name: string): string {
    return this.key([STAGING_FOLDER, name]);
  }

  async uploadOrigin(
    signal: AbortSignal,
    pageOrigin?: string,
  ): Promise<{ origin: string | null; reason: DirectUnavailableReason | null }> {
    const u = checkS3Endpoint(this.cfg.endpoint);
    if (u.protocol !== 'https:') return { origin: null, reason: 'http_endpoint' };
    const { url } = this.url(this.stagingKey('cors-check'));
    const origin = new URL(url).origin;
    if (!pageOrigin) return { origin, reason: null };
    try {
      const res = await this.fetchFn(url, {
        method: 'OPTIONS',
        headers: {
          origin: pageOrigin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type,if-none-match,x-amz-checksum-sha256',
        },
        signal,
      });
      await res.arrayBuffer().catch(() => undefined);
      const allow = res.headers.get('access-control-allow-origin');
      const methods = (res.headers.get('access-control-allow-methods') ?? '').toUpperCase();
      if (res.ok && (allow === pageOrigin || allow === '*') && methods.includes('PUT'))
        return { origin, reason: null };
      return { origin: null, reason: 'cors_missing' };
    } catch {
      return { origin: null, reason: 'probe_failed' };
    }
  }

  async grant(
    stagingName: string,
    file: { size: number; contentType: string; sha256: string },
    ttlMs: number,
    _pageOrigin: string,
    _signal: AbortSignal,
  ): Promise<DirectGrant> {
    const ep = checkS3Endpoint(this.cfg.endpoint);
    if (ep.protocol !== 'https:')
      throw new StorageError('invalid', 'This storage cannot take direct uploads over http.');
    const key = this.stagingKey(stagingName);
    const { url, host, path } = this.url(key);
    const checksum = Buffer.from(file.sha256, 'hex').toString('base64');
    const headers: Record<string, string> = {
      'content-type': file.contentType,
      'if-none-match': '*',
      'x-amz-checksum-sha256': checksum,
    };
    const expires = Math.max(1, Math.ceil(ttlMs / 1000));
    const now = this.now();
    const query = presignV4({
      method: 'PUT',
      host,
      path,
      headers: { ...headers, 'content-length': String(file.size) },
      region: this.cfg.region,
      accessKeyId: this.keys.accessKeyId,
      secretAccessKey: this.keys.secretAccessKey,
      ...(this.keys.sessionToken ? { sessionToken: this.keys.sessionToken } : {}),
      expires,
      now,
    });
    return {
      provider: 's3',
      url: `${url}?${query}`,
      headers,
      chunkBytes: null,
      expiresAt: now.getTime() + expires * 1000,
      stagingRef: key,
    };
  }

  async offset(): Promise<number | null> {
    return null;
  }

  async stat(g: DirectGrant, signal: AbortSignal): Promise<StagedInfo | null> {
    const res = await this.call(
      'HEAD',
      g.stagingRef,
      signal,
      createHash('sha256').update('').digest('hex'),
      undefined,
      { 'x-amz-checksum-mode': 'ENABLED' },
    );
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res);
    const sum = res.headers.get('x-amz-checksum-sha256');
    const sha = sum && /^[A-Za-z0-9+/]{43}=$/.test(sum) ? Buffer.from(sum, 'base64').toString('hex') : undefined;
    const etag = res.headers.get('etag')?.replace(/"/g, '');
    return {
      size: Number(res.headers.get('content-length') ?? -1),
      ...(sha ? { sha256: sha } : {}),
      ...(etag ? { providerId: etag.slice(0, 300) } : {}),
    };
  }

  async read(
    g: DirectGrant,
    range: { start: number; end: number } | null,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await this.call(
      'GET',
      g.stagingRef,
      signal,
      createHash('sha256').update('').digest('hex'),
      undefined,
      range ? { range: `bytes=${range.start}-${range.end}` } : {},
    );
    if (!res.ok || !res.body) await this.fail(res);
    return res.body as ReadableStream<Uint8Array>;
  }

  async promote(
    g: DirectGrant,
    info: StagedInfo,
    target: StorageTarget,
    signal: AbortSignal,
  ): Promise<{ path: string; providerId?: string }> {
    const empty = createHash('sha256').update('').digest('hex');
    for (let n = 1; n <= STORAGE_MAX_CLASH; n++) {
      const name = n === 1 ? target.name : storageClashName(target.name, n);
      const key = this.key([...target.folder, name]);
      const head = await this.call('HEAD', key, signal, empty);
      if (head.status === 200) continue;
      if (head.status !== 404) await this.fail(head);
      const copy = await this.call('PUT', key, signal, empty, undefined, {
        'x-amz-copy-source': `/${this.cfg.bucket}/${uriEncode(g.stagingRef, true)}`,
      });
      if (copy.status === 412) continue;
      if (!copy.ok) await this.fail(copy);
      await copy.arrayBuffer().catch(() => undefined);
      return { path: key, ...(info.providerId ? { providerId: info.providerId } : {}) };
    }
    throw new StorageError('conflict', 'Too many files with the same name.');
  }

  async cancel(g: DirectGrant, signal: AbortSignal): Promise<void> {
    await this.delete(g.stagingRef, signal);
  }

  async sweep(keep: (name: string, modifiedAt: number) => boolean, signal: AbortSignal): Promise<number> {
    const prefix = this.key([STAGING_FOLDER]);
    const empty = createHash('sha256').update('').digest('hex');
    const res = await this.call('GET', '', signal, empty, undefined, {}, {
      'list-type': '2',
      prefix: `${prefix}/`,
    });
    if (!res.ok) await this.fail(res);
    const xml = await res.text();
    let n = 0;
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1] ?? '';
      const key = /<Key>([^<]+)<\/Key>/.exec(body)?.[1];
      const mod = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(body)?.[1] ?? '');
      if (!key || !key.startsWith(`${prefix}/`)) continue;
      const name = key.slice(prefix.length + 1);
      if (keep(name, Number.isFinite(mod) ? mod : 0)) continue;
      await this.delete(key, signal).catch(() => undefined);
      n++;
    }
    return n;
  }
}
