import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, type ChatContext, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { cardAttachmentDirs } from '../src/adapters/claude-code.ts';
import { MockAdapter } from '../src/adapters/mock.ts';
import type { ChatStartInput } from '../src/adapters/types.ts';
import {
  allowedJiraKeys,
  attachFileFromAgent,
  downloadJiraAttachments,
  listJiraAttachments,
  ServerHttp,
  syncCardAttachments,
} from '../src/attachments/index.ts';
import { MockRuntimeConfigSchema } from '../src/config.ts';
import { ExternalAdapters, JiraAdapter } from '../src/external/index.ts';
import {
  JiraCredentialStore,
  jiraFile,
  normalizeJiraBaseUrl,
  resolveJira,
} from '../src/external/jira-store.ts';
import { runnerPaths } from '../src/paths.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const TOKEN = 'ATATT3xFfGF0-secret-token-value';
const CFG = { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', apiToken: TOKEN };
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface FakeAtt {
  id: string;
  filename: string;
  data: Buffer;
  mimeType?: string;
  /** Size Jira claims in the metadata (default: the real size). */
  size?: number;
}

/** A Jira site with tickets and their attachments; records every request. */
function fakeJira(tickets: Record<string, FakeAtt[]>, over: { status?: number } = {}) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.authorization });
    const u = new URL(url);
    if (over.status) return new Response('no', { status: over.status });
    if (u.pathname === '/rest/api/2/myself') return Response.json({ displayName: 'Pieter' });
    const issue = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(u.pathname);
    if (issue) {
      const list = tickets[decodeURIComponent(issue[1] as string)];
      if (!list) return new Response('{}', { status: 404 });
      return Response.json({
        fields: {
          attachment: list.map((a) => ({
            id: a.id,
            filename: a.filename,
            size: a.size ?? a.data.length,
            mimeType: a.mimeType ?? 'application/octet-stream',
            created: '2026-10-10T10:00:00.000+0000',
            author: { displayName: 'Sam' },
          })),
        },
      });
    }
    const dl = /^\/rest\/api\/2\/attachment\/content\/([^/]+)$/.exec(u.pathname);
    if (dl) {
      const att = Object.values(tickets)
        .flat()
        .find((a) => a.id === dl[1]);
      return att ? new Response(new Uint8Array(att.data)) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  return { fetchFn, calls };
}

const adapterFor = (tickets: Record<string, FakeAtt[]>, over: { status?: number } = {}) => {
  const jira = fakeJira(tickets, over);
  return { ...jira, adapter: new JiraAdapter({ config: CFG, fetch: jira.fetchFn }) };
};

const DCPL = 'DCPL-4276';
const TICKET = {
  [DCPL]: [
    { id: '101', filename: 'SlideOutHistory.svg', data: SVG, mimeType: 'image/svg+xml' },
    { id: '102', filename: 'Screenshot 1.png', data: PNG, mimeType: 'image/png' },
  ],
};

describe('Jira attachments downloaded by the runner', () => {
  it('lists the files of the ticket this conversation is about', async () => {
    const { adapter } = adapterFor(TICKET);
    const deps = { jira: () => adapter, scratch: tmp('scratch-'), allowed: [DCPL] };
    const text = await listJiraAttachments(deps, DCPL);
    expect(text).toContain('SlideOutHistory.svg');
    expect(text).toContain('Screenshot 1.png');
    expect(text).toContain('image/svg+xml');
  });

  it('writes the files into the scratch dir and returns their local paths (never the token)', async () => {
    const { adapter, calls } = adapterFor(TICKET);
    const scratch = tmp('scratch-');
    const deps = { jira: () => adapter, scratch, allowed: [DCPL] };
    const out = await downloadJiraAttachments(deps, DCPL.toLowerCase(), undefined, true);
    const dir = join(scratch, 'attachments', DCPL);
    expect(out).toContain(join(dir, 'SlideOutHistory.svg'));
    expect(out).toContain(join(dir, 'Screenshot 1.png'));
    expect(readFileSync(join(dir, 'SlideOutHistory.svg')).equals(SVG)).toBe(true);
    expect(readFileSync(join(dir, 'Screenshot 1.png')).equals(PNG)).toBe(true);
    expect(out).not.toContain(TOKEN);
    // the credentials went to the configured Jira host only, and the URL is built from the id
    expect(calls.every((c) => new URL(c.url).origin === 'https://acme.atlassian.net')).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toContain('/rest/api/2/attachment/content/101');
    // nothing written for the agent mentions the token
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(TOKEN)).toBe(false);
  });

  it('downloads one file by name or by id, and names what exists when it does not', async () => {
    const { adapter } = adapterFor(TICKET);
    const scratch = tmp('scratch-');
    const deps = { jira: () => adapter, scratch, allowed: [DCPL] };
    await downloadJiraAttachments(deps, DCPL, 'screenshot 1.png', false);
    expect(existsSync(join(scratch, 'attachments', DCPL, 'Screenshot 1.png'))).toBe(true);
    expect(existsSync(join(scratch, 'attachments', DCPL, 'SlideOutHistory.svg'))).toBe(false);
    await downloadJiraAttachments(deps, DCPL, '101', false);
    expect(existsSync(join(scratch, 'attachments', DCPL, 'SlideOutHistory.svg'))).toBe(true);
    await expect(downloadJiraAttachments(deps, DCPL, 'nope.png', false)).rejects.toThrow(
      /no attachment 'nope.png'.*SlideOutHistory.svg/,
    );
  });

  it('refuses keys outside the conversation, including other tickets and non-keys', async () => {
    const { adapter, calls } = adapterFor({
      ...TICKET,
      'OTHER-1': [{ id: '9', filename: 'x.png', data: PNG }],
    });
    const deps = { jira: () => adapter, scratch: tmp('scratch-'), allowed: [DCPL] };
    await expect(downloadJiraAttachments(deps, 'OTHER-1', undefined, true)).rejects.toThrow(
      /only read the attachments of DCPL-4276/,
    );
    await expect(listJiraAttachments(deps, 'OTHER-1')).rejects.toThrow(/not OTHER-1/);
    await expect(listJiraAttachments(deps, '../../etc/passwd')).rejects.toThrow(/not a Jira ticket key/);
    expect(calls).toHaveLength(0); // refused before Jira was asked
    const none = { ...deps, allowed: [] };
    await expect(listJiraAttachments(none, DCPL)).rejects.toThrow(/not about a Jira ticket/);
  });

  it('enforces 20 MB per file and 60 MB per call, and reports what it skipped', async () => {
    const big = (id: string, name: string, size: number): FakeAtt => ({
      id,
      filename: name,
      data: Buffer.from('x'),
      size,
    });
    const { adapter } = adapterFor({
      [DCPL]: [
        big('1', 'huge.png', 21 * 1024 * 1024),
        { id: '2', filename: 'ok.png', data: PNG },
        { id: '3', filename: 'lies.png', data: Buffer.alloc(21 * 1024 * 1024, 1), size: 10 },
      ],
    });
    const scratch = tmp('scratch-');
    const deps = { jira: () => adapter, scratch, allowed: [DCPL] };
    const out = await downloadJiraAttachments(deps, DCPL, undefined, true);
    expect(out).toMatch(/huge\.png \(21\.0 MB is over the 20\.0 MB limit per file\)/);
    expect(out).toMatch(/lies\.png/); // the declared size was a lie: the stream cap caught it
    expect(existsSync(join(scratch, 'attachments', DCPL, 'ok.png'))).toBe(true);
    expect(existsSync(join(scratch, 'attachments', DCPL, 'huge.png'))).toBe(false);
    expect(existsSync(join(scratch, 'attachments', DCPL, 'lies.png'))).toBe(false);
  });

  it('says plainly when the runner has no Jira login or Jira refuses it', async () => {
    const none = new JiraAdapter({ config: undefined });
    const deps = { jira: () => none, scratch: tmp('scratch-'), allowed: [DCPL] };
    await expect(listJiraAttachments(deps, DCPL)).rejects.toThrow(/aom-runner jira-connect/);
    const { adapter } = adapterFor(TICKET, { status: 401 });
    await expect(listJiraAttachments({ ...deps, jira: () => adapter }, DCPL)).rejects.toThrow(
      /refused the saved credentials/,
    );
    expect(await adapter.checkStatus()).toMatchObject({ state: 'refused' });
    expect(await none.checkStatus()).toEqual({ state: 'not_connected' });
    expect(await adapterFor(TICKET).adapter.checkStatus()).toMatchObject({
      state: 'connected',
      account: 'Pieter',
    });
  });

  it('allows the ticket of the intake and of the card in context', () => {
    expect(allowedJiraKeys({ intake: { externalSystem: 'jira', externalKey: 'DCPL-4276' } })).toEqual([
      'DCPL-4276',
    ]);
    expect(allowedJiraKeys({ intake: { externalSystem: 'github', externalKey: 'a/b#1' } })).toEqual([]);
    expect(allowedJiraKeys({ cardExternalRef: 'https://acme.atlassian.net/browse/WEB-9' })).toEqual([
      'WEB-9',
    ]);
    expect(allowedJiraKeys({})).toEqual([]);
  });
});

describe('Jira credentials on the runner', () => {
  it('jira-connect stores the token in secrets/ with mode 0600, and config.json still works', () => {
    const paths = runnerPaths(tmp('data-'));
    const store = new JiraCredentialStore(jiraFile(paths.secrets));
    expect(resolveJira(paths.secrets, undefined)).toBeUndefined();
    expect(resolveJira(paths.secrets, CFG)).toEqual(CFG); // the older config.json form
    store.save({ ...CFG, apiToken: 'new-token' });
    const mode = statSync(jiraFile(paths.secrets)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
      expect(statSync(paths.secrets).mode & 0o777).toBe(0o700);
    }
    expect(resolveJira(paths.secrets, CFG)?.apiToken).toBe('new-token'); // the secrets file wins
    expect(store.remove()).toBe(true);
    expect(resolveJira(paths.secrets, CFG)).toEqual(CFG);
  });

  it('normalizes the base URL', () => {
    expect(normalizeJiraBaseUrl('acme.atlassian.net/')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraBaseUrl(' https://jira.acme.com/jira/ ')).toBe('https://jira.acme.com/jira');
    expect(normalizeJiraBaseUrl('ftp://x')).toBeNull();
    expect(normalizeJiraBaseUrl('')).toBeNull();
  });
});

describe('card attachments copied next to a shift', () => {
  const att = (id: string, name: string, data: Buffer) => ({
    id,
    name,
    contentType: 'application/octet-stream',
    size: data.length,
    sha256: sha(data),
  });
  const serverWith = (files: Record<string, Buffer>, seen: string[] = []) => {
    const fetchFn = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      seen.push(
        `${init?.method} ${u.pathname}${u.search} ${(init?.headers as Record<string, string>)?.authorization}`,
      );
      const id = u.pathname.split('/').pop() as string;
      return files[id]
        ? new Response(new Uint8Array(files[id] as Buffer))
        : new Response('{}', { status: 404 });
    };
    return new ServerHttp({ base: () => 'https://aom.example.com', token: () => 'aomr_t', fetch: fetchFn });
  };

  it('writes read-only copies, checks the checksum, and removes what is no longer attached', async () => {
    const dest = join(tmp('tmpdir-'), 'card-attachments');
    const seen: string[] = [];
    const http = serverWith({ a1: SVG, a2: PNG, bad: Buffer.from('other') }, seen);
    const first = await syncCardAttachments({
      dest,
      shiftId: 'shift-1',
      http,
      items: [
        { attachment: att('a1', 'target.svg', SVG) },
        { attachment: att('a2', 'screen.png', PNG) },
        { attachment: att('bad', 'corrupt.txt', Buffer.from('expected')) },
        { attachment: att('gone', 'missing.txt', Buffer.from('m')) },
      ],
    });
    expect(first.files.map((f) => f.name)).toEqual(['target.svg', 'screen.png']);
    expect(first.errors).toHaveLength(2);
    expect(first.errors.join()).toMatch(/checksum/);
    expect(readFileSync(join(dest, 'target.svg')).equals(SVG)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dest, 'target.svg')).mode & 0o222).toBe(0);
    expect(seen[0]).toBe('GET /api/runner/attachments/a1?shift=shift-1 Bearer aomr_t');
    // a later sync mirrors the card: the removed file is gone
    await syncCardAttachments({
      dest,
      shiftId: 'shift-1',
      http,
      items: [{ attachment: att('a2', 'screen.png', PNG) }],
    });
    expect(readdirSync(dest)).toEqual(['screen.png']);
    const empty = await syncCardAttachments({ dest, shiftId: 'shift-1', http, items: [] });
    expect(empty.files).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('keeps the files of several cards apart', async () => {
    const dest = join(tmp('tmpdir-'), 'card-attachments');
    const http = serverWith({ a1: SVG, a2: PNG });
    await syncCardAttachments({
      dest,
      shiftId: 's',
      http,
      items: [
        { ref: 'TOY-1', attachment: att('a1', 'same.svg', SVG) },
        { ref: 'TOY-2', attachment: att('a2', 'same.svg', PNG) },
      ],
    });
    expect(readFileSync(join(dest, 'TOY-1', 'same.svg')).equals(SVG)).toBe(true);
    expect(readFileSync(join(dest, 'TOY-2', 'same.svg')).equals(PNG)).toBe(true);
  });
});

describe('aom card attach (the runner uploads for the agent)', () => {
  const setup = (
    rpcResult: (m: string, p: Record<string, unknown>) => unknown = () => ({
      uploadId: 'up-1',
      ref: 'TOY-1',
      name: 'x',
    }),
  ) => {
    const scratch = tmp('scratch-');
    const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
    const uploads: Array<{ url: string; bytes: number; auth: string }> = [];
    const http = new ServerHttp({
      base: () => 'https://aom.example.com',
      token: () => 'aomr_t',
      fetch: async (url, init) => {
        uploads.push({
          url,
          bytes: (init?.body as Uint8Array | undefined)?.byteLength ?? 0,
          auth: (init?.headers as Record<string, string>)?.authorization as string,
        });
        return Response.json({});
      },
    });
    const run = (path: string, ref?: string) =>
      attachFileFromAgent({
        path,
        ref,
        roots: [scratch],
        http,
        rpc: async (method, params) => {
          rpcs.push({ method, params });
          return { ok: true, result: rpcResult(method, params) };
        },
      });
    return { scratch, rpcs, uploads, run };
  };

  it('asks for a ticket, then uploads the bytes; a downloaded Jira file is marked with its ticket', async () => {
    const t = setup((_m, p) => ({ uploadId: 'up-1', ref: 'TOY-1', name: p.name }));
    const dir = join(t.scratch, 'attachments', DCPL);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SlideOutHistory.svg'), SVG);
    const msg = await t.run(join(dir, 'SlideOutHistory.svg'), 'TOY-1');
    expect(msg).toMatch(/Attached SlideOutHistory.svg .* to TOY-1/);
    expect(t.rpcs).toEqual([
      {
        method: 'card.attach.begin',
        params: {
          ref: 'TOY-1',
          name: 'SlideOutHistory.svg',
          size: SVG.length,
          sha256: sha(SVG),
          source: `jira ${DCPL}`,
        },
      },
    ]);
    expect(t.uploads).toEqual([
      { url: 'https://aom.example.com/api/runner/uploads/up-1', bytes: SVG.length, auth: 'Bearer aomr_t' },
    ]);
  });

  it('only reads files from the agent scratch dir, and refuses programs and big files before asking the server', async () => {
    const t = setup();
    await expect(t.run('/etc/passwd')).rejects.toThrow(/only files in your scratch or temp directory/);
    await expect(t.run(join(t.scratch, '..', '..', 'config.json'))).rejects.toThrow(
      /only files in your scratch/,
    );
    writeFileSync(join(t.scratch, 'setup.exe'), 'MZ....');
    await expect(t.run(join(t.scratch, 'setup.exe'))).rejects.toThrow(/cannot be attached/);
    writeFileSync(join(t.scratch, 'lie.png'), 'not a png');
    await expect(t.run(join(t.scratch, 'lie.png'))).rejects.toThrow(/not a valid .png/);
    await expect(t.run(join(t.scratch, 'missing.png'))).rejects.toThrow(/not a file/);
    expect(t.rpcs).toEqual([]);
    expect(t.uploads).toEqual([]);
  });

  it('passes the server refusal on and uploads nothing', async () => {
    const scratch = tmp('scratch-');
    writeFileSync(join(scratch, 'a.png'), PNG);
    let uploaded = false;
    const http = new ServerHttp({
      base: () => 'https://x',
      token: () => 't',
      fetch: async () => {
        uploaded = true;
        return Response.json({});
      },
    });
    await expect(
      attachFileFromAgent({
        path: join(scratch, 'a.png'),
        roots: [scratch],
        http,
        rpc: async () => ({ ok: false, error: 'TOY-9 is not a card you can attach files to here' }),
      }),
    ).rejects.toThrow(/not a card you can attach files to/);
    expect(uploaded).toBe(false);
  });
});

// ------------------------------------------------------------------------------------- through the real runner

const BA = BUILTIN_ROLES.find((r) => r.key === 'ba') as (typeof BUILTIN_ROLES)[number];
const AGENT_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const THREAD_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';

describe('in a BA chat and in card shifts', () => {
  /** A chat adapter that lets a script call the runner's IPC like `aom` does, and sees the session input. */
  function chatAdapter(
    script: (
      input: ChatStartInput,
      post: (method: string, params?: Record<string, unknown>) => Promise<any>,
    ) => Promise<void>,
    seen: { input?: ChatStartInput; instructions?: string },
  ) {
    const mock = new MockAdapter(MockRuntimeConfigSchema.parse({ enabled: true }), runnerPaths(tmp()));
    return Object.assign(Object.create(mock), {
      id: 'mock',
      capabilities: () => mock.capabilities(),
      writeInstructions: async (_s: unknown, md: string) => {
        seen.instructions = md;
      },
      startChat: async (input: ChatStartInput) => {
        seen.input = input;
        const post = async (method: string, params: Record<string, unknown> = {}) => {
          const res = await fetch(`${input.env.AOM_IPC_URL}/v1/rpc`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${input.env.AOM_SHIFT_TOKEN}`,
            },
            body: JSON.stringify({ method, params }),
          });
          return res.json();
        };
        await script(input, post);
        return mock.startChat(input);
      },
    });
  }
  const intakeContext = (over: Record<string, unknown> = {}): ChatContext =>
    ({
      intake: {
        intakeId: uuidv7(),
        externalSystem: 'jira',
        externalKey: DCPL,
        projects: [],
        cards: [],
        ...over,
      },
    }) as unknown as ChatContext;

  it('downloads the ticket attachments into a folder the agent can read, and never exposes the token', async () => {
    const { fetchFn } = fakeJira(TICKET);
    const seen: { input?: ChatStartInput; instructions?: string } = {};
    const results: any = {};
    const adapter = chatAdapter(async (_i, post) => {
      results.list = await post('source.attachments', { key: DCPL });
      results.get = await post('source.attachment', { key: DCPL, all: true });
      results.other = await post('source.attachments', { key: 'SECRET-1' });
    }, seen);
    h = await startHarness(
      { rpc: () => ({ ok: true, result: {} }) },
      {
        adapters: new Map([['mock', adapter]]),
        external: ExternalAdapters.defaults({ jira: CFG, jiraFetch: fetchFn }),
      },
    );
    const chatId = uuidv7();
    h.server.send('chat.start', {
      chatId,
      threadId: THREAD_ID,
      agent: {
        agentId: AGENT_ID,
        name: 'Ben',
        roleKey: 'ba',
        seniority: 'senior',
        runtime: 'mock',
        model: 'mock',
        skills: [],
        permissions: BA.permissions,
        isDevops: false,
      },
      message: 'go',
      context: intakeContext(),
    });
    await h.server.waitFor('chat.done', (d) => d.chatId === chatId);
    expect(results.list.result).toContain('SlideOutHistory.svg');
    const scratch = seen.input?.sandbox.scratch as string;
    const dir = join(scratch, 'attachments', DCPL);
    expect(results.get.result).toContain(join(dir, 'SlideOutHistory.svg'));
    expect(readFileSync(join(dir, 'SlideOutHistory.svg')).equals(SVG)).toBe(true);
    // the folder is readable by the agent: it is inside the scratch dir, which is a working directory of the chat
    expect(seen.input?.cwd).toBe(scratch);
    // a ticket the conversation is not about is refused
    expect(results.other.ok).toBe(false);
    expect(results.other.error).toMatch(/only read the attachments of DCPL-4276/);
    // the token is nowhere an agent can see: its answers, env, instructions and files
    const visible = JSON.stringify([results, seen.input?.env, seen.instructions]);
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain(Buffer.from(`me@acme.com:${TOKEN}`).toString('base64'));
    const scan = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? scan(join(d, e.name)) : [join(d, e.name)],
      );
    for (const f of scan(scratch)) expect(readFileSync(f).includes(TOKEN)).toBe(false);
  });

  it('attaches a downloaded file to a card through the server (ticket, then bytes)', async () => {
    const { fetchFn } = fakeJira(TICKET);
    const uploads: Array<{ url: string; auth: string; size: number }> = [];
    const rpcs: Array<{ method: string; params: any }> = [];
    const seen: { input?: ChatStartInput; instructions?: string } = {};
    const results: any = {};
    const adapter = chatAdapter(async (_i, post) => {
      await post('source.attachment', { key: DCPL, name: 'SlideOutHistory.svg' });
      const path = join(seen.input?.sandbox.scratch as string, 'attachments', DCPL, 'SlideOutHistory.svg');
      results.ok = await post('card.attach', { path, ref: 'TOY-1' });
      results.outside = await post('card.attach', { path: '/etc/hostname' });
    }, seen);
    h = await startHarness(
      {
        rpc: (m) => {
          rpcs.push({ method: m.method, params: m.params });
          return m.method === 'card.attach.begin'
            ? { ok: true, result: { uploadId: 'up-9', ref: 'TOY-1', name: (m.params as any).name } }
            : { ok: true, result: {} };
        },
      },
      {
        adapters: new Map([['mock', adapter]]),
        external: ExternalAdapters.defaults({ jira: CFG, jiraFetch: fetchFn }),
        serverFetch: (async (url: string, init: RequestInit) => {
          uploads.push({
            url: String(url),
            auth: (init.headers as Record<string, string>).authorization as string,
            size: (init.body as Uint8Array).byteLength,
          });
          return Response.json({});
        }) as typeof fetch,
      },
    );
    const chatId = uuidv7();
    h.server.send('chat.start', {
      chatId,
      threadId: THREAD_ID,
      agent: {
        agentId: AGENT_ID,
        name: 'Ben',
        roleKey: 'ba',
        seniority: 'senior',
        runtime: 'mock',
        model: 'mock',
        skills: [],
        permissions: BA.permissions,
        isDevops: false,
      },
      message: 'go',
      context: intakeContext(),
    });
    await h.server.waitFor('chat.done', (d) => d.chatId === chatId);
    expect(results.ok.result).toMatch(/Attached SlideOutHistory.svg .* to TOY-1/);
    expect(rpcs.find((r) => r.method === 'card.attach.begin')?.params).toMatchObject({
      ref: 'TOY-1',
      name: 'SlideOutHistory.svg',
      sha256: sha(SVG),
      source: `jira ${DCPL}`,
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      url: expect.stringMatching(/\/api\/runner\/uploads\/up-9$/),
      auth: 'Bearer aomr_testtoken',
      size: SVG.length,
    });
    expect(results.outside.ok).toBe(false);
    expect(results.outside.error).toMatch(/only files in your scratch or temp directory/);
  });

  it('a card shift gets its attachments as read-only files outside the worktree, listed in its instructions', async () => {
    const [id1, id2] = [uuidv7(), uuidv7()];
    const files: Record<string, Buffer> = { [id1]: SVG, [id2]: PNG };
    const asked: string[] = [];
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness(
      {},
      {
        adapters: new Map([['mock', adapter]]),
        serverFetch: (async (url: string) => {
          const u = new URL(url);
          asked.push(`${u.pathname}${u.search}`);
          const id = u.pathname.split('/').pop() as string;
          return files[id]
            ? new Response(new Uint8Array(files[id] as Buffer))
            : new Response('{}', { status: 404 });
        }) as typeof fetch,
      },
    );
    const { shiftId } = await h.runShift({
      stage: 'build',
      attachments: [
        {
          id: id1,
          name: 'SlideOutHistory.svg',
          contentType: 'image/svg+xml',
          size: SVG.length,
          sha256: sha(SVG),
        },
        { id: id2, name: 'screen.png', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) },
      ],
    });
    const input = adapter.inputs[0];
    expect(input).toBeDefined();
    const dir = join(input?.sandbox.tmp as string, 'card-attachments');
    expect(readFileSync(join(dir, 'SlideOutHistory.svg')).equals(SVG)).toBe(true);
    expect(readFileSync(join(dir, 'screen.png')).equals(PNG)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'screen.png')).mode & 0o222).toBe(0);
    // outside the worktree, readable by the agent's file tools, and in the instructions
    expect(dir.startsWith(input?.cwd as string)).toBe(false);
    expect(cardAttachmentDirs(input?.sandbox as { tmp: string })).toEqual([dir]); // the claude adapter adds it as a read folder
    expect(input?.instructionsMarkdown).toContain('# Attachments of this card');
    expect(input?.instructionsMarkdown).toContain(join(dir, 'SlideOutHistory.svg'));
    // asked for as this shift
    expect(asked).toContain(`/api/runner/attachments/${id1}?shift=${shiftId}`);
  });

  it('a card shift starts anyway when a file cannot be fetched', async () => {
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness(
      {},
      {
        adapters: new Map([['mock', adapter]]),
        serverFetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
      },
    );
    await h.runShift({
      stage: 'build',
      attachments: [{ id: uuidv7(), name: 'a.png', contentType: 'image/png', size: 1, sha256: sha(PNG) }],
    });
    expect(adapter.inputs).toHaveLength(1);
    expect(adapter.inputs[0]?.instructionsMarkdown).not.toContain('# Attachments of this card');
  });
});
