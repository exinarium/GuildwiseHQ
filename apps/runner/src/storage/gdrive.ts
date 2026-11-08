import { readFile } from 'node:fs/promises';
import { STORAGE_MAX_CLASH, storageClashName, storedPathSegments } from '@aom/shared';
import { authed, httpError, type TokenFn } from './http.ts';
import {
  type FetchLike,
  PROBE_BODY,
  PROBE_NAME,
  type Spooled,
  type StorageConnector,
  StorageError,
  type StorageTarget,
} from './types.ts';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export interface GDriveConfig {
  baseFolder: string;
  baseFolderId?: string;
}

/**
 * Google Drive with the `drive.file` scope: the connector only sees what it created, so everything lives under a base
 * folder it creates (and recreates when the user deleted or trashed it).
 */
export class GDriveConnector implements StorageConnector {
  constructor(
    private cfg: GDriveConfig,
    private readonly token: TokenFn,
    private readonly fetchFn: FetchLike = fetch,
    /** Called with the id of a (re)created base folder so the caller can save it. */
    private readonly onBaseFolder: (id: string) => void = () => undefined,
  ) {}

  private json = (headers: Record<string, string> = {}) => ({
    ...headers,
    'content-type': 'application/json',
  });

  private async createFolder(name: string, parent: string | undefined, signal: AbortSignal): Promise<string> {
    const res = await authed(
      this.fetchFn,
      'google_drive',
      this.token,
      `${API}/files?fields=id`,
      {
        method: 'POST',
        headers: this.json(),
        body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
      },
      signal,
    );
    if (!res.ok) throw new StorageError('permission', 'The folder could not be created.');
    return ((await res.json()) as { id: string }).id;
  }

  /** Creates the base folder (connect). Returns its id. */
  async setup(signal: AbortSignal): Promise<string> {
    const id = await this.createFolder(this.cfg.baseFolder, undefined, signal);
    this.cfg = { ...this.cfg, baseFolderId: id };
    return id;
  }

  private async base(signal: AbortSignal): Promise<string> {
    const id = this.cfg.baseFolderId;
    if (id) {
      const res = await authed(
        this.fetchFn,
        'google_drive',
        this.token,
        `${API}/files/${encodeURIComponent(id)}?fields=id,trashed`,
        { method: 'GET' },
        signal,
      );
      if (res.ok && !((await res.json()) as { trashed?: boolean }).trashed) return id;
      await res.arrayBuffer().catch(() => undefined);
    }
    const created = await this.setup(signal);
    this.onBaseFolder(created);
    return created;
  }

  private async find(
    name: string,
    parent: string,
    folder: boolean,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const query = `name='${q(name)}' and '${q(parent)}' in parents and trashed=false${folder ? ` and mimeType='${FOLDER}'` : ''}`;
    const res = await authed(
      this.fetchFn,
      'google_drive',
      this.token,
      `${API}/files?fields=files(id)&pageSize=1&q=${encodeURIComponent(query)}`,
      { method: 'GET' },
      signal,
    );
    if (!res.ok) throw new StorageError('unavailable', 'The folder could not be listed.');
    return ((await res.json()) as { files?: Array<{ id: string }> }).files?.[0]?.id;
  }

  private async folderPath(segments: string[], signal: AbortSignal): Promise<string> {
    let parent = await this.base(signal);
    for (const seg of segments)
      parent = (await this.find(seg, parent, true, signal)) ?? (await this.createFolder(seg, parent, signal));
    return parent;
  }

  async probe(signal: AbortSignal): Promise<void> {
    const parent = await this.base(signal);
    const id = await this.create(parent, PROBE_NAME(), Buffer.from(PROBE_BODY), 'text/plain', signal);
    await this.delete(`id:${id}`, signal);
  }

  private async create(
    parent: string,
    name: string,
    body: Buffer,
    type: string,
    signal: AbortSignal,
  ): Promise<string> {
    const start = await authed(
      this.fetchFn,
      'google_drive',
      this.token,
      `${UPLOAD}?uploadType=resumable&fields=id`,
      {
        method: 'POST',
        headers: this.json({ 'x-upload-content-type': type, 'x-upload-content-length': String(body.length) }),
        body: JSON.stringify({ name, parents: [parent] }),
      },
      signal,
    );
    const loc = start.headers.get('location');
    if (!start.ok || !loc) throw new StorageError('unavailable', 'The upload could not be started.');
    let res: Response;
    try {
      res = await this.fetchFn(loc, {
        method: 'PUT',
        headers: { 'content-type': type, 'content-length': String(body.length) },
        body: new Uint8Array(body),
        signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError')
        throw new StorageError('timeout', 'The storage did not answer in time.');
      throw new StorageError('unavailable', 'The storage could not be reached.');
    }
    if (!res.ok) throw await httpError('google_drive', res);
    return ((await res.json()) as { id: string }).id;
  }

  async put(
    target: StorageTarget,
    file: Spooled,
    signal: AbortSignal,
  ): Promise<{ path: string; providerId?: string }> {
    const parent = await this.folderPath(target.folder, signal);
    for (let n = 1; n <= STORAGE_MAX_CLASH; n++) {
      const name = n === 1 ? target.name : storageClashName(target.name, n);
      if (await this.find(name, parent, false, signal)) continue;
      const id = await this.create(parent, name, await readFile(file.file), file.contentType, signal);
      return { path: [...target.folder, name].join('/'), providerId: id };
    }
    throw new StorageError('conflict', 'Too many files with the same name.');
  }

  async delete(path: string, signal: AbortSignal): Promise<void> {
    if (!path.startsWith('id:')) return;
    await authed(
      this.fetchFn,
      'google_drive',
      this.token,
      `${API}/files/${encodeURIComponent(path.slice(3))}`,
      { method: 'DELETE' },
      signal,
    );
  }

  /** One folder or file for the parent-chain check; null when it is gone or in the bin. */
  private async meta(
    id: string,
    signal: AbortSignal,
  ): Promise<{ name: string; parents: string[]; mimeType: string } | null> {
    const res = await authed(
      this.fetchFn,
      'google_drive',
      this.token,
      `${API}/files/${encodeURIComponent(id)}?fields=id,name,parents,trashed,mimeType`,
      { method: 'GET' },
      signal,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await httpError('google_drive', res);
    const j = (await res.json()) as {
      name?: string;
      parents?: string[];
      trashed?: boolean;
      mimeType?: string;
    };
    if (j.trashed) return null;
    return { name: j.name ?? '', parents: j.parents ?? [], mimeType: j.mimeType ?? '' };
  }

  /**
   * Strict delete of one file below the base folder. Drive has no paths, so the file id is required, and the file is
   * only removed when its name and its parent chain match the stored path up to the base folder.
   */
  async deleteFile(
    ref: { path: string; providerId?: string },
    signal: AbortSignal,
  ): Promise<'deleted' | 'not_found'> {
    const outside = () => new StorageError('invalid', 'The file is outside the storage destination.');
    const segs = storedPathSegments(ref.path);
    if (!segs || !ref.providerId || !this.cfg.baseFolderId) throw outside();
    const file = await this.meta(ref.providerId, signal);
    if (!file) return 'not_found';
    if (file.mimeType === FOLDER || file.name !== segs[segs.length - 1]) throw outside();
    let parent = file.parents[0];
    for (let i = segs.length - 2; i >= 0; i--) {
      if (!parent) throw outside();
      const folder = await this.meta(parent, signal);
      if (!folder || folder.mimeType !== FOLDER || folder.name !== segs[i]) throw outside();
      parent = folder.parents[0];
    }
    if (!parent || parent !== this.cfg.baseFolderId) throw outside();
    const res = await authed(
      this.fetchFn,
      'google_drive',
      this.token,
      `${API}/files/${encodeURIComponent(ref.providerId)}`,
      { method: 'DELETE' },
      signal,
    );
    if (res.status === 404) return 'not_found';
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 409)
      throw new StorageError('unavailable', 'The storage is busy or unavailable: try again.');
    return 'deleted';
  }
}
