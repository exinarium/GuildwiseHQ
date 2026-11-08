import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { renderStoragePath, type StorageReference, type StorageWriteError } from '@aom/shared';
import { ORIGIN } from './app.ts';
import type { FakeRunner } from './fake-runner.ts';

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('FILE-CONTENT-SENTINEL-png-91d0aa'),
]);
export const PDF = Buffer.from('%PDF-1.7\nFILE-CONTENT-SENTINEL-pdf-4be2c1\n%%EOF');
export const EXE = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  Buffer.from('This program cannot be run'),
]);

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

/** A plain HTTP call to the test server (no proxy, real Content-Length), like a browser would make. */
export function call(
  baseUrl: string,
  method: string,
  path: string,
  o: { headers?: Record<string, string>; body?: Buffer | string | object; ip?: string } = {},
): Promise<HttpResult> {
  const u = new URL(baseUrl);
  const isJson = o.body !== undefined && !Buffer.isBuffer(o.body) && typeof o.body !== 'string';
  const payload =
    o.body === undefined
      ? undefined
      : isJson
        ? Buffer.from(JSON.stringify(o.body))
        : Buffer.from(o.body as Buffer | string);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method,
        path,
        agent: false,
        headers: {
          origin: ORIGIN,
          ...(o.ip ? { 'x-forwarded-for': o.ip } : {}),
          ...(isJson ? { 'content-type': 'application/json' } : {}),
          ...(payload ? { 'content-length': String(payload.length) } : {}),
          ...Object.fromEntries(Object.entries(o.headers ?? {}).filter(([, v]) => v !== undefined)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface StorageStub {
  /** Every file written, relative path to bytes. */
  files(): Array<{ path: string; bytes: Buffer }>;
  /** Number of `storage.write.open` frames seen (what reached the runner). */
  opens(): number;
  /** Return an error for a write to make the "firm's storage" fail; null lets it through. */
  failWhen: (open: { ext?: string; name: string; size: number }) => StorageWriteError | null;
  /** Every `storage.delete` frame seen, in order. */
  deleteFrames: Array<{ requestId: string; path: string; providerId?: string }>;
  /** Return an error for a `storage.delete` to make it fail; null lets it through. Set `ignore` to stay silent. */
  deleteBehavior: { error: StorageWriteError | null; ignore: boolean };
  stop(): void;
}

/**
 * The firm's workstation: answers the write relay's frames like the runner's local-folder connector does, writing to `dir`.
 * Credit is granted on open and for every chunk; the receipt carries the real size and checksum.
 */
export function serveStorage(r: FakeRunner, dir: string, connectionId: string): StorageStub {
  const transfers = new Map<string, { open: any; chunks: Buffer[] }>();
  let opens = 0;
  const stub: StorageStub = {
    files: () => {
      const out: Array<{ path: string; bytes: Buffer }> = [];
      const walk = (d: string, rel: string) => {
        if (!existsSync(d)) return;
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) walk(p, rel ? `${rel}/${name}` : name);
          else out.push({ path: rel ? `${rel}/${name}` : name, bytes: readFileSync(p) });
        }
      };
      walk(dir, '');
      return out;
    },
    opens: () => opens,
    failWhen: () => null,
    deleteFrames: [],
    deleteBehavior: { error: null, ignore: false },
    stop: () => r.ws.off('message', onMessage),
  };
  const onMessage = (data: unknown) => {
    const f = JSON.parse(String(data));
    if (f.type === 'storage.write.open') {
      opens++;
      const err = stub.failWhen({ ext: f.ext, name: f.name, size: f.size });
      if (err) {
        r.send('storage.write.result', { transferId: f.transferId, ok: false, error: err });
        return;
      }
      transfers.set(f.transferId, { open: f, chunks: [] });
      r.send('storage.write.credit', { transferId: f.transferId, upTo: 8 });
    } else if (f.type === 'storage.write.chunk') {
      const t = transfers.get(f.transferId);
      if (!t) return;
      t.chunks.push(Buffer.from(f.data, 'base64'));
      r.send('storage.write.credit', { transferId: f.transferId, upTo: f.seq + 1 + 8 });
    } else if (f.type === 'storage.write.end') {
      const t = transfers.get(f.transferId);
      if (!t) return;
      transfers.delete(f.transferId);
      const body = Buffer.concat(t.chunks);
      const o = t.open;
      const rendered = renderStoragePath({ folder: o.folder, name: o.name }, o.vars, o.ext);
      if (!rendered.ok) {
        r.send('storage.write.result', {
          transferId: f.transferId,
          ok: false,
          error: { code: 'invalid', message: 'bad template', retryable: false },
        });
        return;
      }
      let rel = [...rendered.folder, rendered.name].join('/');
      let n = 1;
      while (existsSync(join(dir, rel))) rel = `${[...rendered.folder, rendered.name].join('/')}.${++n}`;
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
      const reference: StorageReference = {
        v: 1,
        connectionId,
        kind: 'local',
        path: rel,
        size: body.length,
        sha256: sha(body),
        contentType: o.contentType,
        writtenAt: new Date().toISOString(),
      };
      r.send('storage.write.result', { transferId: f.transferId, ok: true, reference });
    } else if (f.type === 'storage.write.abort') {
      transfers.delete(f.transferId);
    } else if (f.type === 'storage.delete') {
      stub.deleteFrames.push({ requestId: f.requestId, path: f.path, providerId: f.providerId });
      if (stub.deleteBehavior.ignore) return;
      if (stub.deleteBehavior.error) {
        r.send('storage.delete.result', {
          requestId: f.requestId,
          ok: false,
          error: stub.deleteBehavior.error,
        });
        return;
      }
      const file = join(dir, f.path);
      const there = existsSync(file);
      if (there) rmSync(file);
      r.send('storage.delete.result', {
        requestId: f.requestId,
        ok: true,
        result: there ? 'deleted' : 'not_found',
      });
    }
  };
  r.ws.on('message', onMessage);
  return stub;
}

// ------------------------------------------------------------------------------------------------ world

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type FormDefinition, newFormDefinition, newFormField } from '@aom/shared';
import { afterAll, beforeAll } from 'vitest';
import { closeAdminPool, q } from './db.ts';
import { createWorld, ok, type World } from './world.ts';

export interface PfWorld {
  w: World;
  r: FakeRunner;
  stub: StorageStub;
  dir: string;
  orgId: string;
  connectionId: string;
  logs: string[];
  api(method: string, url: string, body?: unknown): ReturnType<World['t']['req']>;
  /** A form definition whose destinations are the local test folder. */
  definition(title?: string): FormDefinition;
  createForm(
    def?: FormDefinition,
  ): Promise<{ id: string; latestVersion: number; definition: FormDefinition }>;
  /** Creates and publishes a form; returns its id and the 22 character public id. */
  published(def?: FormDefinition): Promise<{ formId: string; publicId: string; url: string }>;
  get(path: string, headers?: Record<string, string>, ip?: string): Promise<HttpResult>;
  post(path: string, body: unknown, headers?: Record<string, string>, ip?: string): Promise<HttpResult>;
  put(path: string, body: Buffer, headers?: Record<string, string>, ip?: string): Promise<HttpResult>;
  /** The page's first call: the public form with a session. */
  load(publicId: string, link?: string): Promise<HttpResult>;
  /** The start call for answers and files, with a valid session from `load`. */
  start(
    publicId: string,
    dto: any,
    answers: Record<string, unknown>,
    files: Array<{ field: string; name: string; bytes: Buffer }>,
    extra?: Record<string, unknown>,
    ip?: string,
  ): Promise<HttpResult>;
  /** Start, upload every file, complete: the happy path of the page. */
  submit(
    publicId: string,
    answers: Record<string, unknown>,
    files: Array<{ field: string; name: string; bytes: Buffer }>,
    link?: string,
  ): Promise<{
    start: HttpResult;
    parts: HttpResult[];
    complete: HttpResult | null;
    sid: string;
    token: string;
  }>;
  /** Every row of every table, as text. */
  everything(): Promise<string>;
}

export function usePublicFormsWorld(env: Record<string, string> = {}): PfWorld {
  const self = {} as PfWorld;
  beforeAll(async () => {
    self.logs = [];
    self.w = await createWorld({
      logStream: { write: (l: string) => void self.logs.push(l) },
      env: {
        AOM_FIRST_RUN_HIRE_CAP: 'false',
        LOG_LEVEL: 'trace',
        AOM_FORMS_POW_BITS: '0',
        AOM_FORMS_MIN_FILL_MS: '0',
        ...env,
      },
    });
    self.dir = mkdtempSync(join(tmpdir(), 'pf-store-'));
    self.orgId = (await q('SELECT id FROM organizations WHERE owner_user_id=$1', [self.w.owner.id]))[0]
      ?.id as string;
    self.r = await self.w.connectRunner({ capabilities: ['storage:1', 'storage-delete:1'] });
    self.api = (method, url, body) =>
      self.w.t.req(method, url, { cookie: self.w.owner.cookie, ...(body !== undefined ? { body } : {}) });
    const created = await ok<any>(
      self.api('POST', '/api/org/storage/connections', {
        kind: 'local',
        label: 'Firm folder',
        workstationId: self.w.workstationId,
      }),
      201,
    );
    self.connectionId = created.connection.id;
    self.stub = serveStorage(self.r, self.dir, self.connectionId);

    self.definition = (title = 'Rental application') => {
      const d = newFormDefinition(title);
      d.settings.answersDestination.connectionId = self.connectionId;
      const name = newFormField('short_text', 'full_name', 'Full name');
      name.required = true;
      const email = newFormField('email', 'email_addr', 'Email');
      const notes = newFormField('long_text', 'notes', 'Notes');
      const id = newFormField('file', 'id_copy', 'ID copy');
      const photo = newFormField('file', 'photo', 'Photo');
      if (id.type === 'file') {
        id.required = true;
        id.allowedTypes = ['.pdf', 'image/png'];
        id.maxSizeBytes = 1024 * 1024;
        id.destination.connectionId = self.connectionId;
      }
      if (photo.type === 'file') {
        photo.allowedTypes = ['image/png'];
        photo.maxSizeBytes = 1024 * 1024;
        photo.destination.connectionId = self.connectionId;
      }
      d.fields = [name, email, notes, id, photo];
      return d;
    };
    self.createForm = async (def = self.definition()) =>
      ok<any>(self.api('POST', '/api/forms', { definition: def }), 201);
    self.published = async (def) => {
      const f = await self.createForm(def);
      const p = await ok<any>(self.api('POST', `/api/forms/${f.id}/publish`));
      return { formId: f.id, publicId: p.publicId, url: p.url };
    };
    const base = () => self.w.baseUrl;
    self.get = (path, headers = {}, ip) => call(base(), 'GET', path, { headers, ...(ip ? { ip } : {}) });
    self.post = (path, body, headers = {}, ip) =>
      call(base(), 'POST', path, { body: body as object, headers, ...(ip ? { ip } : {}) });
    self.put = (path, body, headers = {}, ip) =>
      call(base(), 'PUT', path, {
        body,
        headers: { 'content-type': 'application/octet-stream', ...headers },
        ...(ip ? { ip } : {}),
      });
    self.load = (publicId, link) =>
      self.get(`/api/public/forms/${publicId}`, link ? { 'x-form-link': link } : {});
    self.start = (publicId, dto, answers, files, extra = {}, ip) =>
      self.post(
        `/api/public/forms/${publicId}/submissions`,
        {
          session: dto.session,
          nonce: '0',
          website: '',
          answers,
          files: files.map((f) => ({
            field: f.field,
            index: 0,
            name: f.name,
            size: f.bytes.length,
            sha256: sha(f.bytes),
          })),
          ...extra,
        },
        {},
        ip,
      );
    self.submit = async (publicId, answers, files, link) => {
      const dto = (await self.load(publicId, link)).json;
      const start = await self.start(publicId, dto, answers, files, link ? { link } : {});
      const parts: HttpResult[] = [];
      let complete: HttpResult | null = null;
      const sid: string = start.json?.submissionId ?? '';
      const token: string = start.json?.uploadToken ?? '';
      if (start.status === 201) {
        for (const [i, f] of files.entries())
          parts.push(
            await self.put(`/api/public/forms/${publicId}/submissions/${sid}/parts/${i}`, f.bytes, {
              'x-upload-token': token,
              'x-file-name': encodeURIComponent(f.name),
            }),
          );
        if (parts.every((p) => p.status === 200))
          complete = await self.post(
            `/api/public/forms/${publicId}/submissions/${sid}/complete`,
            { answers },
            { 'x-upload-token': token },
          );
      }
      return { start, parts, complete, sid, token };
    };
    self.everything = async () => {
      const tables = await q<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
      );
      const out: string[] = [];
      for (const t of tables) {
        const rows = await q(`SELECT row_to_json(x)::text AS j FROM "${t.tablename}" x`);
        out.push(...rows.map((x: any) => x.j));
      }
      return out.join('\n');
    };
  });
  afterAll(async () => {
    self.stub?.stop();
    await self.w?.t.close();
    await closeAdminPool();
  });
  return self;
}
