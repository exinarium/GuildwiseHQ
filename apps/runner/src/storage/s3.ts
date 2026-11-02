import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { STORAGE_MAX_CLASH, storageClashName } from '@aom/shared';
import { fromHttp } from './errors.ts';
import { signV4, uriEncode } from './s3-sign.ts';
import {
  type FetchLike,
  PROBE_BODY,
  PROBE_NAME,
  type Spooled,
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
export class S3Connector implements StorageConnector {
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
    method: 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    signal: AbortSignal,
    payloadHash: string,
    body?: RequestInit['body'],
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const { url, host, path } = this.url(key);
    const headers = signV4({
      method,
      host,
      path,
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
}
