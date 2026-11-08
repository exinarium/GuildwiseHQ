import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';

// Public form files to an S3-compatible bucket go straight from the submitter's browser to the bucket with a presigned
// PUT the runner issues; the Guildwise server only brokers small JSON control calls. A local folder keeps the streamed
// relay. The bucket is a small https S3 stand-in on this machine: it checks the presigned SigV4 signature (path, size,
// headers, expiry), the checksum and If-None-Match the way S3 does, answers CORS, and can drop the checksum (a provider
// that exposes no hash) so the runner has to read the object back. Standalone: one user, one mock runner.
test.describe.configure({ mode: 'serial' });

const OWNER = { email: 'direct@e2e.test', name: 'E2E Direct', password: 'direct-password-12345' };
const HOME = paths.runnerHome('storage-direct');
const FOLDER = join(E2E_DIR, 'storage-direct-local');
const SETTINGS = '/settings/org?tab=storage';
const BUCKET = 'firm-uploads';
const PREFIX = 'clients';
const KEY_ID = 'AKIAE2EDIRECT000001';
const SECRET = 'e2e-direct-secret-key-9b1c77ad';
const REGION = 'eu-west-1';
const STAGING = `/${BUCKET}/${PREFIX}/.guildwise-incoming/`;
const MiB = 1024 * 1024;
/** The server takes only a named https host as an upload origin (no IP literal, no localhost). */
const S3_HOST = 's3.e2e.test';

let page: Page;
let api: APIRequestContext;
let pubBrowser: Browser | undefined;
let pub: BrowserContext;

/** A self-signed certificate for the bucket's host name (the runner trusts it through NODE_EXTRA_CA_CERTS). */
function hostCert(dir: string): { certPath: string; keyPath: string } {
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, 'bucket-cert.pem');
  const keyPath = join(dir, 'bucket-key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      `/CN=${S3_HOST}`,
      '-addext',
      `subjectAltName=DNS:${S3_HOST}`,
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  return { certPath, keyPath };
}
let workstationId: string;
let s3Id: string;
let localId: string;
let s3Origin: string;

// ------------------------------------------------------------------------------------------------ the bucket

interface Obj {
  body: Buffer;
  checksum?: string;
  modified: Date;
}
interface Call {
  method: string;
  path: string;
  presigned: boolean;
  status: number;
  bytes: number;
  origin: string;
}
const s3 = {
  /** S3 proper: enforce and expose x-amz-checksum-sha256. Off: a provider without a hash (the runner reads it back). */
  checksums: true,
  objects: new Map<string, Obj>(),
  calls: [] as Call[],
};
let s3Server: Server | null = null;

const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d, 'utf8').digest();
const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** SigV4 query-string auth as S3 checks it; returns the S3 error code or null. Written from the AWS spec, not the runner. */
function checkPresigned(
  method: string,
  rawPath: string,
  url: URL,
  headers: Record<string, unknown>,
): string | null {
  const p = url.searchParams;
  if (p.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return 'AuthorizationQueryParametersError';
  const amz = p.get('X-Amz-Date') ?? '';
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amz);
  const expires = Number(p.get('X-Amz-Expires'));
  if (!m || !Number.isFinite(expires)) return 'AuthorizationQueryParametersError';
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (Date.now() > at + expires * 1000) return 'AccessDenied'; // Request has expired
  const [keyId, date, region, service, term] = (p.get('X-Amz-Credential') ?? '').split('/');
  if (
    keyId !== KEY_ID ||
    date !== amz.slice(0, 8) ||
    region !== REGION ||
    service !== 's3' ||
    term !== 'aws4_request'
  )
    return 'InvalidAccessKeyId';
  const signed = (p.get('X-Amz-SignedHeaders') ?? '').split(';');
  const canonHeaders: string[] = [];
  for (const n of signed) {
    const v = headers[n];
    if (v === undefined) return 'SignatureDoesNotMatch';
    canonHeaders.push(`${n}:${String(v).trim().replace(/\s+/g, ' ')}\n`);
  }
  const query = [...p.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .sort()
    .join('&');
  const canonical = [
    method,
    rawPath,
    query,
    canonHeaders.join(''),
    signed.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date ?? ''), REGION), 's3'), 'aws4_request');
  const sig = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return sig === p.get('X-Amz-Signature') ? null : 'SignatureDoesNotMatch';
}

function startS3(cert: { certPath: string; keyPath: string }): Promise<number> {
  const server = createServer(
    { cert: readFileSync(cert.certPath), key: readFileSync(cert.keyPath) },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'https://s3.invalid');
        const rawPath = url.pathname;
        const path = decodeURIComponent(rawPath);
        const origin = String(req.headers.origin ?? '');
        const presigned = url.searchParams.has('X-Amz-Signature');
        const call: Call = {
          method: req.method ?? '',
          path,
          presigned,
          status: 0,
          bytes: body.length,
          origin,
        };
        s3.calls.push(call);
        const head: Record<string, string> = origin
          ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'etag', vary: 'Origin' }
          : {};
        const send = (status: number, h: Record<string, string> = {}, out = '') => {
          call.status = status;
          res.writeHead(status, { ...head, ...h });
          res.end(out);
        };
        const xml = (status: number, code: string) =>
          send(
            status,
            { 'content-type': 'application/xml' },
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>x</Message></Error>`,
          );
        if (req.method === 'OPTIONS')
          return send(200, {
            'access-control-allow-methods': 'GET, PUT, HEAD',
            'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? ''),
            'access-control-max-age': '5',
          });
        if (presigned) {
          const err = checkPresigned(req.method ?? '', rawPath, url, req.headers);
          if (err) return xml(403, err);
        } else if (
          !String(req.headers.authorization ?? '').startsWith(`AWS4-HMAC-SHA256 Credential=${KEY_ID}/`)
        )
          return xml(403, 'AccessDenied');
        const obj = s3.objects.get(path);
        if (req.method === 'PUT') {
          const src = req.headers['x-amz-copy-source'];
          if (src) {
            const from = s3.objects.get(decodeURIComponent(String(src)));
            if (!from) return xml(404, 'NoSuchKey');
            if (req.headers['if-none-match'] === '*' && obj) return xml(412, 'PreconditionFailed');
            s3.objects.set(path, { ...from, modified: new Date() });
            return send(
              200,
              { 'content-type': 'application/xml' },
              '<CopyObjectResult><ETag>"c"</ETag></CopyObjectResult>',
            );
          }
          if (req.headers['if-none-match'] === '*' && obj) return xml(412, 'PreconditionFailed');
          const sum = req.headers['x-amz-checksum-sha256'];
          const real = createHash('sha256').update(body).digest('base64');
          if (s3.checksums && sum && sum !== real) return xml(400, 'BadDigest');
          s3.objects.set(path, {
            body,
            modified: new Date(),
            ...(s3.checksums && sum ? { checksum: String(sum) } : {}),
          });
          return send(200, { etag: `"${sha256hex(body).slice(0, 32)}"` });
        }
        if (req.method === 'DELETE') {
          s3.objects.delete(path);
          return send(204);
        }
        if (req.method === 'HEAD') {
          if (!obj) return send(404);
          const h: Record<string, string> = {
            'content-length': String(obj.body.length),
            etag: `"${sha256hex(obj.body).slice(0, 32)}"`,
          };
          if (obj.checksum && req.headers['x-amz-checksum-mode'] === 'ENABLED')
            h['x-amz-checksum-sha256'] = obj.checksum;
          call.status = 200;
          res.writeHead(200, { ...head, ...h });
          return res.end();
        }
        if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const items = [...s3.objects.entries()]
            .map(([k, o]) => ({ key: k.slice(`/${BUCKET}/`.length), o }))
            .filter((x) => x.key.startsWith(prefix))
            .map(
              (x) =>
                `<Contents><Key>${x.key}</Key><LastModified>${x.o.modified.toISOString()}</LastModified></Contents>`,
            );
          return send(
            200,
            { 'content-type': 'application/xml' },
            `<ListBucketResult>${items.join('')}</ListBucketResult>`,
          );
        }
        if (req.method === 'GET') {
          if (!obj) return xml(404, 'NoSuchKey');
          const r = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
          const part = r ? obj.body.subarray(Number(r[1]), Number(r[2]) + 1) : obj.body;
          call.status = r ? 206 : 200;
          res.writeHead(call.status, { ...head, 'content-length': String(part.length) });
          return res.end(part);
        }
        xml(405, 'MethodNotAllowed');
      });
    },
  );
  s3Server = server;
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
}

/** Objects outside the staging folder: what the firm sees as delivered. */
const delivered = () => [...s3.objects.entries()].filter(([k]) => !k.startsWith(STAGING));
const staged = () => [...s3.objects.entries()].filter(([k]) => k.startsWith(STAGING));

/** A PDF of `size` bytes with a sentinel the server log and database must never contain. */
function pdf(size: number, sentinel: string): Buffer {
  const headTxt = Buffer.from(`%PDF-1.7\n%${sentinel}\n`);
  const tail = Buffer.from('\n%%EOF\n');
  const fill = Buffer.alloc(Math.max(0, size - headTxt.length - tail.length));
  for (let i = 0; i < fill.length; i++) fill[i] = 32 + ((i * 7) % 90);
  return Buffer.concat([headTxt, fill, tail]);
}

/** The page's proof of work: sha256(`session:nonce`) starts with `bits` zero bits. */
function solvePow(session: string, bits: number): string {
  for (let n = 0; ; n++) {
    const h = createHash('sha256').update(`${session}:${n}`).digest();
    let left = bits;
    let ok = true;
    for (const byte of h) {
      if (left <= 0) break;
      if (left >= 8) {
        if (byte !== 0) ok = false;
        left -= 8;
      } else {
        if (byte >> (8 - left) !== 0) ok = false;
        left = 0;
      }
      if (!ok) break;
    }
    if (ok) return String(n);
  }
}

// ------------------------------------------------------------------------------------------------ forms

function definition(title: string, fileConn: string, maxSizeBytes = 8 * MiB) {
  return {
    schemaVersion: 1,
    settings: {
      title,
      description: '',
      logo: null,
      answersDestination: { connectionId: localId, folder: 'Forms/{form}', name: '{date}-{submission}' },
      confirmationText: 'Thank you. We have received your answers.',
    },
    fields: [
      { type: 'short_text', id: 'full_name', label: 'Full name', required: true },
      {
        type: 'file',
        id: 'id_copy',
        label: 'ID copy',
        required: true,
        allowedTypes: ['.pdf'],
        maxSizeBytes,
        destination: {
          connectionId: fileConn,
          folder: 'Forms/{form}/{submission}',
          name: '{field}-{original}',
        },
      },
    ],
  };
}

async function publish(title: string, fileConn: string, max?: number): Promise<string> {
  const created = await api.post('/api/forms', { data: { definition: definition(title, fileConn, max) } });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).id as string;
  const p = await api.post(`/api/forms/${id}/publish`);
  expect(p.status(), await p.text()).toBe(200);
  return (await p.json()).publicId as string;
}

interface Traffic {
  toServer: number;
  relayPuts: string[];
  grants: number;
  cancels: string[];
  sid: string;
}

/** Opens the public page as an anonymous submitter and records what the browser sends to this server. */
async function openForm(publicId: string): Promise<{ p: Page; t: Traffic }> {
  const p = await pub.newPage();
  const t: Traffic = { toServer: 0, relayPuts: [], grants: 0, cancels: [], sid: '' };
  p.on('request', (r) => {
    if (!r.url().startsWith(BASE_URL)) return;
    t.toServer += r.postDataBuffer()?.length ?? 0;
    const path = new URL(r.url()).pathname;
    if (r.method() === 'PUT' && /\/parts\/\d+$/.test(path)) t.relayPuts.push(path);
    if (r.method() === 'POST' && path.endsWith('/grant')) t.grants++;
    if (r.method() === 'POST' && path.endsWith('/grant/cancel'))
      t.cancels.push(String(r.postDataJSON()?.reason));
  });
  p.on('response', async (r) => {
    if (
      r.request().method() === 'POST' &&
      /\/api\/public\/forms\/[^/]+\/submissions$/.test(new URL(r.url()).pathname)
    )
      t.sid = ((await r.json().catch(() => ({}))) as { submissionId?: string }).submissionId ?? '';
  });
  await p.goto(`/f/${publicId}`);
  await expect(p.getByTestId('form-submit')).toBeVisible();
  return { p, t };
}

async function fillAndSend(p: Page, file: { name: string; buffer: Buffer }): Promise<void> {
  await p.getByLabel('Full name').fill('Pat Client');
  await p.locator('input[type="file"]').setInputFiles({ ...file, mimeType: 'application/pdf' });
  await p.getByTestId('form-submit').click();
}

const submission = async (sid: string) =>
  (
    await q<{ status: string; error_code: string | null; parts: any[] }>(
      'SELECT status, error_code, parts FROM form_submissions WHERE id=$1',
      [sid],
    )
  )[0];

const serverLog = () => (existsSync(paths.serverLog) ? readFileSync(paths.serverLog, 'utf8') : '');

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** A request with the browser's grant URL, from outside the browser (a replay). */
function replay(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = httpsRequest(
      {
        host: '127.0.0.1',
        servername: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'PUT',
        rejectUnauthorized: false,
        headers: { ...headers, host: u.host, 'content-length': String(body.length) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}

// ------------------------------------------------------------------------------------------------ setup

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, OWNER);
  api = await apiAs(OWNER.email, OWNER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  // seal with the real time (global setup may pin the server's test clock ahead; the runner checks the real clock)
  await page.route('**/api/workstations/*/integrations', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (typeof body?.serverTime === 'string') body.serverTime = new Date().toISOString();
    await route.fulfill({ response: res, json: body });
  });
  // the submitter: no account, its own browser that finds the bucket's host name on this machine (no proxy) and trusts
  // the bucket's per-run certificate as a browser trusts a real provider's
  const noProxy = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(https?|all|ftp)_proxy$/i.test(k)),
  ) as Record<string, string>;
  pubBrowser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${S3_HOST} 127.0.0.1`, '--no-proxy-server'],
    env: {
      ...noProxy,
      NO_PROXY: `${S3_HOST},localhost,127.0.0.1`,
      no_proxy: `${S3_HOST},localhost,127.0.0.1`,
    },
  });
  pub = await pubBrowser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  mkdirSync(FOLDER, { recursive: true });
});

// on a failure, what the bucket saw (no signatures: paths, methods and answers only)
test.afterEach(async () => {
  const info = test.info();
  if (info.status !== info.expectedStatus)
    console.log(`bucket calls: ${JSON.stringify(s3.calls.slice(-20))}`);
});

test.afterAll(async () => {
  await pubBrowser?.close();
  const server = s3Server;
  s3Server = null;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test('setup: a runner with an https S3-compatible bucket (direct uploads ready) and a local folder', async () => {
  const cert = hostCert(join(E2E_DIR, 'storage-direct-tls'));
  const port = await startS3(cert);
  s3Origin = `https://${S3_HOST}:${port}`;
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Direct PC', HOME);
  // the runner finds the bucket's host name on this machine and trusts its certificate as it would a public provider's
  startRunner(
    {
      NODE_EXTRA_CA_CERTS: cert.certPath,
      NODE_OPTIONS: `--import=${pathToFileURL(join(ROOT, 'e2e/support/hosts-preload.mjs')).href}`,
      AOM_E2E_HOSTS: `${S3_HOST}=127.0.0.1`,
    },
    HOME,
  );
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;

  const add = async (kind: string, label: string) => {
    await page.goto(SETTINGS);
    await page.getByTestId('storage-new').click();
    const d = page.getByTestId('storage-add-dialog');
    await d.getByLabel('Type').selectOption(kind);
    await d.getByLabel('Display name').fill(label);
    await expect(d.getByLabel('Workstation')).toHaveValue(workstationId);
    await page.getByTestId('storage-add-next').click();
    await expect(page.getByTestId('storage-connect-dialog')).toBeVisible();
  };
  const listed = async () =>
    (await (await api.get('/api/org/storage/connections')).json()).connections as Array<{
      id: string;
      label: string;
      health: { state: string };
      directUploads?: { state: string; reason: string | null } | null;
    }>;

  await add('local', 'Office folder');
  const dialog = page.getByTestId('storage-connect-dialog');
  await dialog.getByLabel('Folder on the workstation').fill(FOLDER);
  await page.getByTestId('storage-seal-connect').click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  localId = (await listed()).find((c) => c.label === 'Office folder')?.id as string;

  await add('s3', 'Client bucket');
  await dialog.getByLabel('Endpoint').fill(s3Origin);
  await dialog.getByLabel('Region').fill(REGION);
  await dialog.getByLabel('Bucket').fill(BUCKET);
  await dialog.getByLabel('Folder prefix (optional)').fill(PREFIX);
  await dialog.getByLabel('Use path-style addresses (MinIO and most self-hosted stores)').check();
  await dialog.getByLabel('Access key id').fill(KEY_ID);
  await dialog.getByLabel('Secret access key').fill(SECRET);
  await page.getByTestId('storage-seal-connect').click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  s3Id = (await listed()).find((c) => c.label === 'Client bucket')?.id as string;
  await expect(page.getByTestId(`storage-state-${s3Id}`)).toHaveText('Connected', { timeout: 20_000 });

  // the runner checked the bucket's CORS from the page origin and reported the upload host
  const rows = await waitFor(
    'the S3 connection takes direct uploads',
    listed,
    (r) => r.find((c) => c.id === s3Id)?.directUploads?.state === 'ready',
    30_000,
  ).catch((e) => {
    throw new Error(`${(e as Error).message}\nbucket calls: ${JSON.stringify(s3.calls)}`);
  });
  expect(rows.find((c) => c.id === localId)?.directUploads ?? null).toBeNull();
  expect(s3.calls.some((c) => c.method === 'OPTIONS' && c.origin === BASE_URL)).toBe(true);
});

// ------------------------------------------------------------------------------------------------ direct path

let directForm: string;

test('the public page rules allow exactly the bucket origin for uploads, nothing broader', async () => {
  directForm = await publish('Direct upload intake', s3Id);
  const res = await pub.request.get(`/f/${directForm}`);
  expect(res.status()).toBe(200);
  const csp = res.headers()['content-security-policy'] ?? '';
  const connect = /connect-src ([^;]*)/.exec(csp)?.[1]?.trim().split(/\s+/) ?? [];
  expect(connect).toEqual(["'self'", s3Origin]);
  expect(csp).not.toContain('*');
  expect(csp.match(/https?:\/\/[^\s;']+/g) ?? []).toEqual([s3Origin]);
  const dto = await (await pub.request.get(`/api/public/forms/${directForm}`)).json();
  expect(dto.uploadOrigins).toEqual([s3Origin]);
});

let grantUrl = '';
let grantHeaders: Record<string, string> = {};
let firstFile: Buffer;
let directKey = '';

test('a 3 MB file lands in the bucket straight from the browser; the server sees only small JSON calls', async () => {
  firstFile = pdf(3 * MiB, 'FILE-SENTINEL-direct-a71c');
  s3.calls = [];
  const { p, t } = await openForm(directForm);
  p.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().startsWith(s3Origin)) {
      grantUrl = r.url();
      grantHeaders = Object.fromEntries(
        Object.entries(r.headers()).filter(([k]) =>
          ['content-type', 'if-none-match', 'x-amz-checksum-sha256'].includes(k),
        ),
      );
    }
  });
  await fillAndSend(p, { name: 'passport.pdf', buffer: firstFile });
  await expect(p.getByTestId('form-confirmation')).toBeVisible({ timeout: 90_000 });

  // the firm's bucket holds the exact bytes at the form's path, under the prefix
  const got = delivered();
  expect(got.length).toBe(1);
  const [key, obj] = got[0] as [string, Obj];
  expect(key.startsWith(`/${BUCKET}/${PREFIX}/Forms/`)).toBe(true);
  directKey = key;
  expect(obj.body.equals(firstFile)).toBe(true);

  // the bytes went browser -> bucket with the presigned URL (no keys in the browser), never through the relay
  const put = s3.calls.find((c) => c.method === 'PUT' && c.presigned);
  expect(put?.status).toBe(200);
  expect(put?.bytes).toBe(firstFile.length);
  expect(put?.origin).toBe(BASE_URL);
  expect(put?.path.startsWith(STAGING)).toBe(true);
  expect(t.relayPuts).toEqual([]);
  expect(t.grants).toBe(1);
  // everything the browser sent to this server for the whole submission is control-sized JSON
  expect(t.toServer).toBeLessThan(32 * 1024);

  // the runner checked the staged object and moved it into place with its own signed calls
  const runnerCalls = s3.calls.filter((c) => !c.presigned && c.method !== 'OPTIONS');
  expect(runnerCalls.some((c) => c.method === 'HEAD' && c.path === put?.path)).toBe(true);
  expect(runnerCalls.some((c) => c.method === 'PUT' && c.path === key)).toBe(true);

  // the submission records the file as delivered by the direct path
  const sub = await submission(t.sid);
  expect(sub?.status).toBe('complete');
  expect(sub?.parts[0]).toMatchObject({ state: 'stored', mode: 'direct' });

  // the grant URL is a secret: its signature and the file content are nowhere on the server
  const sig = new URL(grantUrl).searchParams.get('X-Amz-Signature') as string;
  expect(sig).toMatch(/^[0-9a-f]{64}$/);
  const log = serverLog();
  expect(log).not.toContain(sig);
  expect(log).not.toContain('FILE-SENTINEL-direct-a71c');
  const db =
    JSON.stringify(await q('SELECT * FROM form_submissions')) +
    JSON.stringify(await q('SELECT * FROM events'));
  expect(db).not.toContain(sig);
  expect(db).not.toContain('X-Amz-Signature');
  expect(db).not.toContain('FILE-SENTINEL-direct-a71c');
  await p.close();
});

test('the grant covers one path, the declared size and a short TTL, and a second use fails', async () => {
  const u = new URL(grantUrl);
  // TTL: 5 min plus the declared size at 128 KiB/s (design 5.7): about 324 s for 3 MiB, never past 30 min
  const ttl = Number(u.searchParams.get('X-Amz-Expires'));
  expect(ttl).toBeGreaterThanOrEqual(300);
  expect(ttl).toBeLessThanOrEqual(330);
  expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe(
    'content-length;content-type;host;if-none-match;x-amz-checksum-sha256',
  );
  expect(u.searchParams.get('X-Amz-Credential')?.startsWith(`${KEY_ID}/`)).toBe(true);
  expect(u.search).not.toContain(SECRET);

  // a second PUT with the same URL: the staged object is the used marker (If-None-Match) -> refused
  expect(await replay(grantUrl, grantHeaders, firstFile)).toBe(412);
  // the same signature for another path or a larger file -> refused by the signature
  const other = grantUrl.replace('/.guildwise-incoming/', '/.guildwise-incoming/other-');
  expect(await replay(other, grantHeaders, firstFile)).toBe(403);
  expect(await replay(grantUrl, grantHeaders, Buffer.concat([firstFile, Buffer.from('more')]))).toBe(403);
  // nothing new was delivered
  expect(delivered().length).toBe(1);
});

test('a file the form limits refuse gets no grant and the page shows the field error', async () => {
  const { p, t } = await openForm(directForm);
  const s3Before = s3.calls.length;
  await p.getByLabel('Full name').fill('Pat Client');
  await p.locator('input[type="file"]').setInputFiles({
    name: 'huge.pdf',
    mimeType: 'application/pdf',
    buffer: pdf(9 * MiB, 'FILE-SENTINEL-huge'),
  });
  await p.getByTestId('form-submit').click();
  await expect(p.getByTestId('error-id_copy')).toBeVisible();
  await p.waitForTimeout(1500);
  expect(t.grants).toBe(0);
  expect(t.sid).toBe('');
  expect(s3.calls.length).toBe(s3Before);
  await p.close();

  // the server refuses the same declaration itself, before any grant (a page that skipped its own check)
  const dto = await (await pub.request.get(`/api/public/forms/${directForm}`)).json();
  const nonce = solvePow(dto.session as string, Number(dto.powBits ?? 0));
  await new Promise((r) => setTimeout(r, Number(dto.minFillMs ?? 3000) + 500));
  const start = (files: unknown[]) =>
    pub.request.post(`/api/public/forms/${directForm}/submissions`, {
      headers: { origin: BASE_URL },
      data: { session: dto.session, nonce, website: '', answers: { full_name: 'P' }, files },
    });
  const big = await start([
    { field: 'id_copy', index: 0, name: 'huge.pdf', size: 9 * MiB, sha256: 'a'.repeat(64) },
  ]);
  expect(big.status(), await big.text()).toBe(413);
  expect((await big.json()).error).toMatchObject({ code: 'file_too_large' });
  const exe = await start([
    { field: 'id_copy', index: 0, name: 'tool.exe', size: 1000, sha256: 'b'.repeat(64) },
  ]);
  expect(exe.status(), await exe.text()).toBe(415);
  expect((await exe.json()).error).toMatchObject({ code: 'file_type_refused' });
  expect(s3.calls.length).toBe(s3Before);
  expect(serverLog()).not.toContain('huge.pdf?X-Amz');
});

test('a provider without a hash: bytes changed on the way are found by the runner, deleted, and the submitter sees an error', async () => {
  s3.checksums = false;
  const file = pdf(1 * MiB, 'FILE-SENTINEL-tamper');
  const { p, t } = await openForm(directForm);
  // same length, one byte changed after the browser hashed the file (a proxy or a broken disk)
  await p.route(`${s3Origin}/**`, async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') return route.continue();
    const body = Buffer.from(req.postDataBuffer() ?? file);
    body[body.length - 20] = body[body.length - 20] === 65 ? 66 : 65;
    await route.continue({ postData: body });
  });
  const before = delivered().length;
  await fillAndSend(p, { name: 'tampered.pdf', buffer: file });
  await expect(p.getByTestId('public-notice')).toBeVisible({ timeout: 90_000 });
  await expect(p.getByTestId('form-confirmation')).toHaveCount(0);
  // the runner read the object back (no provider hash), found the mismatch and deleted it
  await waitFor(
    'the staged object is deleted',
    async () => staged().filter(([k]) => !k.includes(grantKey())).length,
    (n) => n === 0,
    20_000,
  );
  expect(s3.calls.some((c) => c.method === 'GET' && !c.presigned && c.path.startsWith(STAGING))).toBe(true);
  expect(delivered().length).toBe(before);
  const sub = await submission(t.sid);
  expect(sub?.status).not.toBe('complete');
  expect(sub?.parts[0]?.state).not.toBe('stored');
  s3.checksums = true;
  await p.close();
});

/** The staging key of the first (successful) upload, kept as the used marker until its URL expires. */
const grantKey = () => decodeURIComponent(new URL(grantUrl).pathname);

test('a larger body than declared is refused by the bucket; after one new grant the page fails cleanly with nothing stored', async () => {
  const file = pdf(512 * 1024, 'FILE-SENTINEL-oversize');
  const { p, t } = await openForm(directForm);
  await p.route(`${s3Origin}/**`, async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') return route.continue();
    await route.continue({ postData: Buffer.concat([req.postDataBuffer() ?? file, Buffer.alloc(4096, 65)]) });
  });
  const before = delivered().length;
  const s3Before = s3.calls.length;
  await fillAndSend(p, { name: 'oversize.pdf', buffer: file });
  await expect(p.getByTestId('public-notice')).toBeVisible({ timeout: 90_000 });
  const puts = s3.calls.slice(s3Before).filter((c) => c.method === 'PUT' && c.presigned);
  expect(puts.length).toBe(2);
  expect(puts.every((c) => c.status === 403)).toBe(true);
  expect(t.grants).toBe(2);
  expect(t.cancels).toContain('retry');
  expect(delivered().length).toBe(before);
  expect(staged().filter(([k]) => k !== grantKey()).length).toBe(0);
  expect((await submission(t.sid))?.status).not.toBe('complete');
  await p.close();
});

test('a browser that cannot reach the bucket at all cancels the grant and says the files could not be sent (no relay)', async () => {
  const file = pdf(256 * 1024, 'FILE-SENTINEL-blocked');
  const { p, t } = await openForm(directForm);
  await p.route(`${s3Origin}/**`, (route) => route.abort('blockedbyclient'));
  await fillAndSend(p, { name: 'blocked.pdf', buffer: file });
  // not retryable: the page closes with the message
  await expect(p.getByRole('alert')).toContainText('Your files could not be sent to the firm', {
    timeout: 60_000,
  });
  expect(t.cancels).toContain('blocked');
  expect(t.relayPuts).toEqual([]);
  expect(t.toServer).toBeLessThan(32 * 1024);
  expect((await submission(t.sid))?.status).not.toBe('complete');
  await p.close();
});

// ------------------------------------------------------------------------------------------------ relay path

test('a local folder destination still uses the streamed relay through the server', async () => {
  const form = await publish('Local intake', localId);
  const csp = (await pub.request.get(`/f/${form}`)).headers()['content-security-policy'] ?? '';
  expect(/connect-src ([^;]*)/.exec(csp)?.[1]?.trim()).toBe("'self'");
  const file = pdf(200 * 1024, 'FILE-SENTINEL-local');
  const s3Before = s3.calls.length;
  const { p, t } = await openForm(form);
  await fillAndSend(p, { name: 'lease.pdf', buffer: file });
  await expect(p.getByTestId('form-confirmation')).toBeVisible({ timeout: 90_000 });
  expect(t.grants).toBe(0);
  expect(t.relayPuts.length).toBe(1);
  expect(s3.calls.length).toBe(s3Before);
  const stored = filesUnder(FOLDER).filter((f) => f.endsWith('lease.pdf'));
  expect(stored.length).toBe(1);
  expect(readFileSync(stored[0] as string).equals(file)).toBe(true);
  const sub = await submission(t.sid);
  expect(sub?.status).toBe('complete');
  expect(sub?.parts[0]?.state).toBe('stored');
  expect(sub?.parts[0]?.mode).toBeUndefined();
  await p.close();
});

// ------------------------------------------------------------------------------------------------ file name

test('a file sent straight to the bucket keeps the submitter file name in the destination template, as with the relay', async () => {
  // the field's name template is '{field}-{original}': the relay above stored 'id_copy-lease.pdf'
  expect(filesUnder(FOLDER).some((f) => f.endsWith('id_copy-lease.pdf'))).toBe(true);
  expect(directKey.split('/').pop()).toBe('id_copy-passport.pdf');
});
