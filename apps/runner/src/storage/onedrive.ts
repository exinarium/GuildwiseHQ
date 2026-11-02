import { createReadStream } from 'node:fs';
import { STORAGE_MAX_CLASH, storageClashName } from '@aom/shared';
import { authed, type TokenFn } from './http.ts';
import {
  type FetchLike,
  PROBE_BODY,
  PROBE_NAME,
  type Spooled,
  type StorageConnector,
  StorageError,
  type StorageTarget,
} from './types.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CHUNK = 320 * 1024 * 16; // 5 MiB, a multiple of 320 KiB
const enc = encodeURIComponent;

export interface OneDriveConfig {
  siteUrl?: string;
  driveId: string;
  baseFolder: string;
  baseItemId?: string;
}

/** Resolves the drive (OneDrive of the user, or the document library of a SharePoint site) and creates the base folder. */
export async function setupOneDrive(
  fetchFn: FetchLike,
  token: TokenFn,
  opts: { siteUrl?: string; baseFolder: string },
  signal: AbortSignal,
): Promise<Required<Pick<OneDriveConfig, 'driveId' | 'baseItemId'>>> {
  const get = async (path: string) => {
    const r = await authed(fetchFn, 'onedrive', token, `${GRAPH}${path}`, { method: 'GET' }, signal);
    if (r.status === 404) throw new StorageError('not_found', 'The drive or site was not found.');
    return (await r.json()) as { id: string };
  };
  let driveId: string;
  if (opts.siteUrl) {
    let u: URL;
    try {
      u = new URL(opts.siteUrl);
    } catch {
      throw new StorageError('invalid', 'The SharePoint site address is not valid.');
    }
    const site = await get(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, '')}`);
    driveId = (await get(`/sites/${site.id}/drive`)).id;
  } else driveId = (await get('/me/drive')).id;
  const base = await ensureChild(fetchFn, token, driveId, 'root', opts.baseFolder, signal);
  return { driveId, baseItemId: base };
}

async function ensureChild(
  fetchFn: FetchLike,
  token: TokenFn,
  driveId: string,
  parent: string,
  name: string,
  signal: AbortSignal,
): Promise<string> {
  const post = await authed(
    fetchFn,
    'onedrive',
    token,
    `${GRAPH}/drives/${driveId}/items/${parent}/children`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    },
    signal,
  );
  if (post.ok) return ((await post.json()) as { id: string }).id;
  if (post.status !== 409) throw new StorageError('permission', 'The folder could not be created.');
  const get = await authed(
    fetchFn,
    'onedrive',
    token,
    `${GRAPH}/drives/${driveId}/items/${parent}:/${enc(name)}`,
    { method: 'GET' },
    signal,
  );
  if (!get.ok) throw new StorageError('permission', 'The folder could not be opened.');
  return ((await get.json()) as { id: string }).id;
}

/** OneDrive and SharePoint document libraries through Microsoft Graph. */
export class OneDriveConnector implements StorageConnector {
  constructor(
    private readonly cfg: OneDriveConfig,
    private readonly token: TokenFn,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private get base(): string {
    return this.cfg.baseItemId ?? 'root';
  }

  async probe(signal: AbortSignal): Promise<void> {
    const name = PROBE_NAME();
    const url = `${GRAPH}/drives/${this.cfg.driveId}/items/${this.base}:/${enc(name)}:/content`;
    const put = await authed(
      this.fetchFn,
      'onedrive',
      this.token,
      url,
      { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: PROBE_BODY },
      signal,
    );
    if (!put.ok) throw new StorageError('permission', 'The folder cannot be written to.');
    const id = ((await put.json()) as { id?: string }).id;
    if (id) await this.delete(`id:${id}`, signal);
  }

  async put(target: StorageTarget, file: Spooled, signal: AbortSignal): Promise<{ path: string; providerId?: string }> {
    let parent = this.base;
    for (const seg of target.folder)
      parent = await ensureChild(this.fetchFn, this.token, this.cfg.driveId, parent, seg, signal);
    for (let n = 1; n <= STORAGE_MAX_CLASH; n++) {
      const name = n === 1 ? target.name : storageClashName(target.name, n);
      const sess = await authed(
        this.fetchFn,
        'onedrive',
        this.token,
        `${GRAPH}/drives/${this.cfg.driveId}/items/${parent}:/${enc(name)}:/createUploadSession`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
        },
        signal,
      );
      if (sess.status === 409) continue;
      if (!sess.ok) throw new StorageError('unavailable', 'The upload could not be started.');
      const { uploadUrl } = (await sess.json()) as { uploadUrl: string };
      const item = await this.upload(uploadUrl, file, signal);
      return { path: [...target.folder, name].join('/'), ...(item ? { providerId: item } : {}) };
    }
    throw new StorageError('conflict', 'Too many files with the same name.');
  }

  private async upload(url: string, file: Spooled, signal: AbortSignal): Promise<string | undefined> {
    if (file.size === 0) {
      // An upload session cannot take an empty file: write it directly is not possible with a session; refuse clearly.
      throw new StorageError('invalid', 'An empty file cannot be stored.');
    }
    let sent = 0;
    let id: string | undefined;
    const chunks = createReadStream(file.file, { highWaterMark: CHUNK });
    for await (const part of chunks) {
      const buf = part as Buffer;
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'PUT',
          headers: {
            'content-length': String(buf.length),
            'content-range': `bytes ${sent}-${sent + buf.length - 1}/${file.size}`,
          },
          body: new Uint8Array(buf),
          signal,
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw new StorageError('timeout', 'The storage did not answer in time.');
        throw new StorageError('unavailable', 'The storage could not be reached.');
      }
      sent += buf.length;
      if (!res.ok) {
        const { httpError } = await import('./http.ts');
        throw await httpError('onedrive', res);
      }
      if (res.status === 200 || res.status === 201) id = ((await res.json()) as { id?: string }).id;
      else await res.arrayBuffer().catch(() => undefined);
    }
    return id;
  }

  async delete(path: string, signal: AbortSignal): Promise<void> {
    // `id:<id>` from a probe; otherwise a root-relative path under the base folder.
    const url = path.startsWith('id:')
      ? `${GRAPH}/drives/${this.cfg.driveId}/items/${path.slice(3)}`
      : `${GRAPH}/drives/${this.cfg.driveId}/items/${this.base}:/${path.split('/').map(enc).join('/')}`;
    await authed(this.fetchFn, 'onedrive', this.token, url, { method: 'DELETE' }, signal);
  }
}
