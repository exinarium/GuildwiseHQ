import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { redact } from '../src/secrets/redact.ts';
import { SealedFile } from '../src/secrets/sealed-file.ts';
import { StorageService, type StorageServiceDeps } from '../src/storage/service.ts';
import { StorageSecretsSchema, StorageStore } from '../src/storage/store.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const OTHER = '7a1f0e55-3a63-4c6d-8d0b-0c8f3b2f9e22';
const ACCESS = 'access-TOKEN-marker';
const REFRESH = 'refresh-TOKEN-marker';
const keyOf = () => Buffer.alloc(32, 7);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

type Frame = { type: string; payload: Record<string, any> };

function setup(over: Partial<StorageServiceDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-storage-'));
  const secretsDir = join(root, 'secrets');
  const stored = join(root, 'files');
  mkdirSync(stored);
  const frames: Frame[] = [];
  const logs: string[] = [];
  let fields: Record<string, string> = { root: stored };
  const svc = new StorageService({
    secretsDir,
    spoolDir: join(root, 'tmp', 'storage'),
    keyOf,
    keys: {
      open: (_e: unknown, outer: { ref: string }) => ({ ref: outer.ref, exp: Date.now() + 1000, fields }),
    } as never,
    seen: { claim: () => true },
    workstationId: 'ws',
    send: (type, payload) => frames.push({ type, payload }),
    vaults: {
      exclusive: async () => {
        throw new Error('vault is not configured');
      },
      isLocal: () => true,
    },
    forbiddenRoots: [secretsDir],
    sleep: async () => undefined,
    log: (l) => logs.push(l),
    ...over,
  });
  return {
    svc,
    root,
    secretsDir,
    stored,
    frames,
    logs,
    setFields: (f: Record<string, string>) => (fields = f),
  };
}

const write = async (
  t: ReturnType<typeof setup>,
  body: Buffer,
  opts: { id?: string; conn?: string; folder?: string; name?: string } = {},
) => {
  const id = opts.id ?? '5c9d1d0e-1b6e-4c0f-9a53-2c1f3e4a5b66';
  t.svc.onMessage({
    type: 'storage.write.open',
    transferId: id,
    connectionId: opts.conn ?? CONN,
    folder: opts.folder ?? '{client}',
    name: opts.name ?? 'doc',
    vars: { client: 'Smith' },
    ext: 'txt',
    contentType: 'text/plain',
    size: body.length,
    deadlineMs: 5000,
  } as never);
  await new Promise((r) => setTimeout(r, 30));
  if (t.frames.some((f) => f.type === 'storage.write.result')) return id;
  const chunks = Math.ceil(body.length / 4) || 0;
  for (let i = 0; i < chunks; i++)
    t.svc.onMessage({
      type: 'storage.write.chunk',
      transferId: id,
      seq: i,
      data: body.subarray(i * 4, i * 4 + 4).toString('base64'),
    } as never);
  t.svc.onMessage({
    type: 'storage.write.end',
    transferId: id,
    chunks,
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  } as never);
  for (let i = 0; i < 100 && !t.frames.some((f) => f.type === 'storage.write.result'); i++)
    await new Promise((r) => setTimeout(r, 10));
  return id;
};
const result = (t: ReturnType<typeof setup>) =>
  t.frames.find((f) => f.type === 'storage.write.result')?.payload;

describe('local connection', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    const r = await t.svc.handle('storage.connect', {
      requestId: 'r1',
      connectionId: CONN,
      kind: 'local',
      envelope: {},
    });
    expect(r.error).toBeUndefined();
  });

  it('connects: probes the folder, stores the entry and reports connected', () => {
    const rep = t.frames.find((f) => f.type === 'storage.report');
    expect(rep?.payload.connections[0]).toMatchObject({ connectionId: CONN, state: 'connected' });
    expect(new StorageStore(t.secretsDir, keyOf).get(CONN)?.kind).toBe('local');
    expect(readdirSync(t.stored)).toEqual([]); // the probe file is gone
  });

  it('writes a file with a template and answers with a reference', async () => {
    await write(t, Buffer.from('hello world'));
    const r = result(t);
    expect(r?.ok).toBe(true);
    expect(r?.reference).toMatchObject({
      connectionId: CONN,
      kind: 'local',
      path: 'Smith/doc.txt',
      size: 11,
    });
    expect(r?.reference.sha256).toBe(createHash('sha256').update('hello world').digest('hex'));
    expect(readFileSync(join(t.stored, 'Smith', 'doc.txt'), 'utf8')).toBe('hello world');
    expect(t.frames.some((f) => f.type === 'storage.write.credit' && f.payload.upTo === 8)).toBe(true);
  });

  it('never overwrites: a second file gets -2', async () => {
    await write(t, Buffer.from('one'), { id: '1b9d1d0e-1b6e-4c0f-9a53-2c1f3e4a5b66' });
    t.frames.length = 0;
    await write(t, Buffer.from('two'), { id: '2b9d1d0e-1b6e-4c0f-9a53-2c1f3e4a5b66' });
    expect(result(t)?.reference.path).toBe('Smith/doc-2.txt');
    expect(readFileSync(join(t.stored, 'Smith', 'doc.txt'), 'utf8')).toBe('one');
  });

  it('refuses a damaged upload (wrong checksum) with a typed error and leaves nothing behind', async () => {
    const id = '3b9d1d0e-1b6e-4c0f-9a53-2c1f3e4a5b66';
    t.svc.onMessage({
      type: 'storage.write.open',
      transferId: id,
      connectionId: CONN,
      folder: 'x',
      name: 'f',
      vars: {},
      contentType: 'text/plain',
      size: 3,
      deadlineMs: 5000,
    } as never);
    await new Promise((r) => setTimeout(r, 30));
    t.svc.onMessage({
      type: 'storage.write.chunk',
      transferId: id,
      seq: 0,
      data: Buffer.from('abc').toString('base64'),
    } as never);
    t.svc.onMessage({
      type: 'storage.write.end',
      transferId: id,
      chunks: 1,
      size: 3,
      sha256: '0'.repeat(64),
    } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(result(t)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(existsSync(join(t.stored, 'x'))).toBe(false);
    expect(t.svc.activeTransfers()).toBe(0);
  });

  it('answers not_found for an unknown connection', async () => {
    await write(t, Buffer.from('x'), { conn: OTHER });
    expect(result(t)).toMatchObject({ ok: false, error: { code: 'not_found', retryable: false } });
  });

  it('logs no path, name or content for a write', async () => {
    await write(t, Buffer.from('client secret content'));
    const log = t.logs.join('\n');
    expect(log).toMatch(/^storage\.write conn=.* kind=local size=21 ok \d+ms/m);
    expect(log).not.toContain('Smith');
    expect(log).not.toContain('content');
  });

  it('test connection reports success; a vanished folder is a typed error', async () => {
    expect(
      (await t.svc.handle('storage.test', { requestId: 'r2', connectionId: CONN })).error,
    ).toBeUndefined();
    const { rmSync } = await import('node:fs');
    rmSync(t.stored, { recursive: true });
    const bad = await t.svc.handle('storage.test', { requestId: 'r3', connectionId: CONN });
    expect(bad.error).toMatchObject({ code: 'not_found' });
    expect(bad.health).toMatchObject({ state: 'not_on_workstation' });
  });

  it('remove deletes the entry and the file when it was the last one', async () => {
    expect(existsSync(join(t.secretsDir, 'storage.json'))).toBe(true);
    expect(await t.svc.handle('storage.remove', { connectionId: CONN })).toEqual({ removed: true });
    expect(existsSync(join(t.secretsDir, 'storage.json'))).toBe(false);
  });

  it('sync deletes connections the server no longer lists', async () => {
    const r = await t.svc.handle('storage.sync', { connectionIds: [OTHER] });
    expect(r.removed).toEqual([CONN]);
    expect(new StorageStore(t.secretsDir, keyOf).get(CONN)).toBeUndefined();
  });
});

describe('connect refusals', () => {
  it('refuses a relative path, the runner data folder and a missing folder; nothing is stored', async () => {
    const t = setup();
    for (const root of ['relative/path', t.secretsDir, join(t.root, 'missing')]) {
      t.setFields({ root });
      const r = await t.svc.handle('storage.connect', {
        requestId: 'r',
        connectionId: CONN,
        kind: 'local',
        envelope: {},
      });
      expect(r.error).toBeDefined();
    }
    expect(new StorageStore(t.secretsDir, keyOf).get(CONN)).toBeUndefined();
  });

  it('refuses plain http to a public S3 endpoint', async () => {
    const t = setup();
    t.setFields({
      endpoint: 'http://s3.example.com',
      region: 'r',
      bucket: 'b',
      accessKeyId: 'AK',
      secretAccessKey: 'SK-secret',
    });
    const r = await t.svc.handle('storage.connect', {
      requestId: 'r',
      connectionId: CONN,
      kind: 's3',
      envelope: {},
    });
    expect(r.error).toMatchObject({ code: 'invalid' });
  });
});

describe('S3 connection with a stopped store', () => {
  it('connect fails with unavailable in a bounded time and stores nothing', async () => {
    const t = setup({
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    t.setFields({
      endpoint: 'http://localhost:9000',
      region: 'r',
      bucket: 'b',
      accessKeyId: 'AK',
      secretAccessKey: 'SK-secret',
    });
    const r = await t.svc.handle('storage.connect', {
      requestId: 'r',
      connectionId: CONN,
      kind: 's3',
      envelope: {},
    });
    expect(r.error).toMatchObject({ code: 'unavailable', retryable: true });
    expect(new StorageStore(t.secretsDir, keyOf).get(CONN)).toBeUndefined();
  });
});

describe('OneDrive sign-in keeps tokens on the workstation', () => {
  const calls: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/devicecode'))
      return json(200, {
        device_code: 'DEV',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 1,
      });
    if (url.endsWith('/token')) {
      const body = String(init?.body);
      if (body.includes('refresh_token')) return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3600,
        scope: 'Files.ReadWrite.All',
      });
    }
    if (url.endsWith('/me/drive')) return json(200, { id: 'drive1' });
    if (url.includes('/children')) return json(201, { id: 'base1' });
    return json(200, { id: 'x' });
  };

  it('never sends, logs or stores a token in the clear; reauth is flagged and a new sign-in clears it', async () => {
    const t = setup({ fetch: fetchFn as never, oauthEnv: { AOM_STORAGE_MS_CLIENT_ID: 'client-id' } });
    const begin = await t.svc.handle('storage.auth.begin', {
      sessionId: 's1',
      connectionId: CONN,
      kind: 'onedrive',
      options: {},
    });
    expect(begin.prompt).toMatchObject({ userCode: 'ABCD-EFGH' });
    for (
      let i = 0;
      i < 50 && !t.frames.some((f) => f.type === 'storage.auth' && f.payload.state === 'done');
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(t.frames.some((f) => f.type === 'storage.auth' && f.payload.state === 'done')).toBe(true);

    // every frame, every log line and the raw file hold no token
    const everything = JSON.stringify(t.frames) + t.logs.join('\n') + JSON.stringify(begin);
    expect(everything).not.toContain(ACCESS);
    expect(everything).not.toContain(REFRESH);
    const raw = readFileSync(join(t.secretsDir, 'storage.json'), 'utf8');
    expect(raw).not.toContain(ACCESS);
    expect(raw).not.toContain(REFRESH);
    // but the workstation can read it back
    const sealed = new SealedFile(join(t.secretsDir, 'storage.json'), keyOf, StorageSecretsSchema).load();
    expect(sealed?.connections[CONN]?.auth).toMatchObject({
      type: 'oauth',
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });

    // an expired grant: the write fails with auth_expired and the connection is marked
    const store = new StorageStore(t.secretsDir, keyOf);
    const cur = store.get(CONN);
    if (cur?.auth?.type === 'oauth') store.put(CONN, { ...cur, auth: { ...cur.auth, expiresAt: 0 } });
    t.frames.length = 0;
    await write(t, Buffer.from('x'), { name: 'a' });
    expect(result(t)).toMatchObject({ ok: false, error: { code: 'auth_expired' } });
    expect(store.get(CONN)?.needsReauth).toBe(true);
    expect(
      t.frames.some((f) => f.type === 'storage.report' && f.payload.connections[0].state === 'needs_reauth'),
    ).toBe(true);

    // reconnect: a new sign-in keeps the config and clears the flag
    await t.svc.handle('storage.auth.begin', {
      sessionId: 's2',
      connectionId: CONN,
      kind: 'onedrive',
      options: {},
    });
    for (let i = 0; i < 50 && store.get(CONN)?.needsReauth; i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.get(CONN)?.needsReauth).toBeFalsy();
    expect(store.get(CONN)?.config).toMatchObject({
      kind: 'onedrive',
      driveId: 'drive1',
      baseItemId: 'base1',
    });

    // remove deletes the token file
    await t.svc.handle('storage.remove', { connectionId: CONN });
    expect(existsSync(join(t.secretsDir, 'storage.json'))).toBe(false);
  });

  it('says so when no Microsoft app is configured', async () => {
    const t = setup({ oauthEnv: {} });
    const r = await t.svc.handle('storage.auth.begin', {
      sessionId: 's',
      connectionId: CONN,
      kind: 'onedrive',
      options: {},
    });
    expect(r.error).toMatchObject({ code: 'invalid' });
  });
});

describe('token refresh racing remove', () => {
  const X = 'c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e01';
  const Y = 'd2e3f4a5-1b2c-4d3e-9f4a-5b6c7d8e9f02';
  const NEW_ACCESS = 'race-NEW-access-marker';
  const NEW_REFRESH = 'race-NEW-refresh-marker';
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ok()).toBe(true);
  };

  /** A fetch double: the refresh of `held` waits until the test releases it; every other call answers at once. */
  function double(held: string) {
    const revoked: string[] = [];
    const refreshed: string[] = [];
    let release: ((r: Response) => void) | undefined;
    const fetchFn = async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (url.endsWith('/revoke')) {
        revoked.push(body.get('token') ?? '');
        return json(200, {});
      }
      if (url.endsWith('/token') && body.get('grant_type') === 'refresh_token') {
        const rt = body.get('refresh_token') ?? '';
        refreshed.push(rt);
        if (rt === held) return new Promise<Response>((r) => (release = r));
        return json(200, { access_token: `${rt}-fresh-access`, expires_in: 3600 });
      }
      if (url.startsWith('https://www.googleapis.com/upload/') && init?.method === 'POST')
        return new Response('{}', { status: 200, headers: { location: 'https://upload.test/session' } });
      return json(200, { id: 'x', files: [] });
    };
    return {
      fetchFn,
      revoked,
      refreshed,
      isHeld: () => release !== undefined,
      release: (r: Response) => release?.(r),
    };
  }

  const fresh = () => json(200, { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 });

  const seedGoogle = (t: ReturnType<typeof setup>, id: string, refresh: string) =>
    new StorageStore(t.secretsDir, keyOf).put(id, {
      kind: 'google_drive',
      savedAt: new Date().toISOString(),
      config: { kind: 'google_drive', baseFolder: 'x', baseFolderId: 'f1' },
      auth: {
        type: 'oauth',
        accessToken: `${refresh}-old-access`,
        refreshToken: refresh,
        expiresAt: 0,
        scope: '',
      },
    } as never);

  const seedOneDrive = (t: ReturnType<typeof setup>, id: string, refresh: string) =>
    new StorageStore(t.secretsDir, keyOf).put(id, {
      kind: 'onedrive',
      savedAt: new Date().toISOString(),
      config: { kind: 'onedrive', driveId: 'drive1', baseFolder: 'x', baseItemId: 'base1' },
      auth: {
        type: 'oauth',
        accessToken: `${refresh}-old-access`,
        refreshToken: refresh,
        expiresAt: 0,
        scope: '',
      },
    } as never);

  const googleEnv = { AOM_STORAGE_GOOGLE_CLIENT_ID: 'gid' };
  const msEnv = { AOM_STORAGE_MS_CLIENT_ID: 'client-id' };

  it('remove during a held refresh (Google Drive test): no entry comes back and the test fails with not_found', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: X });
    await until(d.isHeld);

    // remove does not wait for the refresh
    expect(await t.svc.handle('storage.remove', { connectionId: X })).toEqual({ removed: true });
    expect(d.revoked).toEqual(['gx-refresh']);

    d.release(fresh());
    const r = await op;
    expect(r.error).toMatchObject({ code: 'not_found' });
    expect(new StorageStore(t.secretsDir, keyOf).get(X)).toBeUndefined();
    expect(existsSync(join(t.secretsDir, 'storage.json'))).toBe(false);
    // the rotated refresh token nobody holds is revoked, best effort
    await until(() => d.revoked.includes(NEW_REFRESH));

    const everything = JSON.stringify(t.frames) + t.logs.join('\n') + JSON.stringify(r);
    expect(everything).not.toContain(NEW_ACCESS);
    expect(everything).not.toContain(NEW_REFRESH);
    // never registered for redaction
    expect(redact(NEW_ACCESS)).toBe(NEW_ACCESS);
    expect(redact(NEW_REFRESH)).toBe(NEW_REFRESH);
  });

  it('keeps other entries and drops only the removed one from the sealed file', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    seedGoogle(t, Y, 'gy-refresh');
    const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: X });
    await until(d.isHeld);
    await t.svc.handle('storage.remove', { connectionId: X });
    d.release(fresh());
    expect((await op).error).toMatchObject({ code: 'not_found' });
    const sealed = new SealedFile(join(t.secretsDir, 'storage.json'), keyOf, StorageSecretsSchema).load();
    expect(sealed?.connections[X]).toBeUndefined();
    expect(sealed?.connections[Y]).toBeDefined();
  });

  it('remove during a held refresh (OneDrive write): the write fails with not_found and nothing is revoked', async () => {
    const d = double('ox-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: msEnv });
    seedOneDrive(t, X, 'ox-refresh');
    t.svc.onMessage({
      type: 'storage.write.open',
      transferId: '6c9d1d0e-1b6e-4c0f-9a53-2c1f3e4a5b66',
      connectionId: X,
      folder: 'f',
      name: 'doc',
      vars: {},
      ext: 'txt',
      contentType: 'text/plain',
      size: 1,
      deadlineMs: 5000,
    } as never);
    await until(d.isHeld);
    expect(await t.svc.handle('storage.remove', { connectionId: X })).toEqual({ removed: true });
    d.release(fresh());
    await until(() => result(t) !== undefined);
    expect(result(t)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(t.svc.activeTransfers()).toBe(0);
    expect(new StorageStore(t.secretsDir, keyOf).get(X)).toBeUndefined();
    expect(existsSync(join(t.secretsDir, 'storage.json'))).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.revoked).toEqual([]);
    expect(JSON.stringify(t.frames) + t.logs.join('\n')).not.toContain(NEW_ACCESS);
  });

  it('storage.sync during a held refresh: the entry stays gone', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: X });
    await until(d.isHeld);
    expect((await t.svc.handle('storage.sync', { connectionIds: [OTHER] })).removed).toEqual([X]);
    d.release(fresh());
    expect((await op).error).toMatchObject({ code: 'not_found' });
    expect(new StorageStore(t.secretsDir, keyOf).get(X)).toBeUndefined();
    expect(existsSync(join(t.secretsDir, 'storage.json'))).toBe(false);
  });

  it('refresh finishes first: its tokens are saved, then remove deletes the entry and revokes them', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: X });
    await until(d.isHeld);
    d.release(fresh());
    expect((await op).error).toBeUndefined();
    const store = new StorageStore(t.secretsDir, keyOf);
    expect(store.get(X)?.auth).toMatchObject({ refreshToken: NEW_REFRESH, accessToken: NEW_ACCESS });
    // the re-read entry is spread, so the config is kept
    expect(store.get(X)?.config).toMatchObject({ baseFolderId: 'f1' });
    expect(await t.svc.handle('storage.remove', { connectionId: X })).toEqual({ removed: true });
    expect(store.get(X)).toBeUndefined();
    expect(d.revoked).toEqual([NEW_REFRESH]);
  });

  it('a held refresh on X does not block a refresh or remove on Y', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    seedGoogle(t, Y, 'gy-refresh');
    const opX = t.svc.handle('storage.test', { requestId: 'rx', connectionId: X });
    await until(d.isHeld);

    expect((await t.svc.handle('storage.test', { requestId: 'ry', connectionId: Y })).error).toBeUndefined();
    const store = new StorageStore(t.secretsDir, keyOf);
    expect(store.get(Y)?.auth).toMatchObject({ accessToken: 'gy-refresh-fresh-access' });
    expect(await t.svc.handle('storage.remove', { connectionId: Y })).toEqual({ removed: true });
    expect(store.get(Y)).toBeUndefined();

    d.release(fresh());
    expect((await opX).error).toBeUndefined();
    expect(store.get(X)?.auth).toMatchObject({ refreshToken: NEW_REFRESH });
  });

  it('an expired grant after removal gives not_found and no needs_reauth report', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: X });
    await until(d.isHeld);
    await t.svc.handle('storage.remove', { connectionId: X });
    t.frames.length = 0;
    d.release(json(400, { error: 'invalid_grant' }));
    const r = await op;
    expect(r.error).toMatchObject({ code: 'not_found' });
    expect(new StorageStore(t.secretsDir, keyOf).get(X)).toBeUndefined();
    expect(
      t.frames.some(
        (f) =>
          f.type === 'storage.report' &&
          f.payload.connections.some((c: { state: string }) => c.state === 'needs_reauth'),
      ),
    ).toBe(false);
  });

  it('a new sign-in during the refresh wins: nothing is written over it and nothing is revoked', async () => {
    const d = double('gx-refresh');
    const t = setup({ fetch: d.fetchFn as never, oauthEnv: googleEnv });
    seedGoogle(t, X, 'gx-refresh');
    const op = t.svc.handle('storage.test', { requestId: 'r', connectionId: X });
    await until(d.isHeld);
    const store = new StorageStore(t.secretsDir, keyOf);
    const cur = store.get(X);
    store.put(X, {
      ...cur!,
      auth: {
        type: 'oauth',
        accessToken: 'signin-access',
        refreshToken: 'signin-refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: '',
      },
    } as never);
    d.release(fresh());
    expect((await op).error).toBeUndefined();
    expect(store.get(X)?.auth).toMatchObject({
      refreshToken: 'signin-refresh',
      accessToken: 'signin-access',
    });
    expect(d.revoked).toEqual([]);
  });
});
