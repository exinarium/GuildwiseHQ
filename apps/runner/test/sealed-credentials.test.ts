import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JIRA_UNREADABLE, JiraCredentialStore, jiraFile, resolveJira } from '../src/external/jira-store.ts';
import { GitLabForge } from '../src/forge/gitlab.ts';
import { FileTokenStore, TOKENS_UNREADABLE } from '../src/forge/tokens.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { JiraIntegration } from '../src/integrations/jira.ts';
import type { AdapterEnv } from '../src/integrations/types.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { SealedFile } from '../src/secrets/sealed-file.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const keyA = () => Buffer.alloc(32, 7);
const keyB = () => Buffer.alloc(32, 8);
const secretsDir = () => join(mkdtempSync(join(tmp(), 'sealed-')), 'secrets');
const tokensFile = (dir: string) => join(dir, 'git-tokens.json');
const JIRA = {
  baseUrl: 'https://acme.atlassian.net',
  email: 'jira-user@acme.com',
  apiToken: 'JIRA-TOKEN-123',
};
const TOKENS = [
  'GL-TOKEN-1',
  'BB-TOKEN-2',
  'AZ-TOKEN-ACME',
  'AZ-TOKEN-OTHER',
  'OLD-AZ-TOKEN',
  'OLD-GL-TOKEN',
];

afterEach(() => {
  for (const t of [JIRA.apiToken, ...TOKENS]) unregisterSecret(t);
});

const isEnvelope = (file: string) => {
  const env = JSON.parse(readFileSync(file, 'utf8'));
  expect(env).toMatchObject({ v: 1, alg: 'A256GCM' });
  expect(typeof env.iv).toBe('string');
  expect(typeof env.ct).toBe('string');
  expect(typeof env.tag).toBe('string');
};
/** Every byte of every file in the secrets directory, as text. */
const everything = (dir: string) =>
  readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');

const jiraEnv = (dir: string, over: Partial<AdapterEnv> = {}) =>
  ({
    paths: { secrets: dir },
    config: () => ({ jira: undefined }),
    now: () => new Date('2026-11-08T00:00:00Z'),
    ...over,
  }) as unknown as AdapterEnv;

describe('Jira credentials are sealed at rest', () => {
  it('save writes an envelope without the token or the e-mail and loads back the same values', () => {
    const dir = secretsDir();
    new JiraCredentialStore(jiraFile(dir), keyA).save(JIRA);
    isEnvelope(jiraFile(dir));
    const raw = readFileSync(jiraFile(dir), 'utf8');
    expect(raw).not.toContain(JIRA.apiToken);
    expect(raw).not.toContain(JIRA.email);
    expect(new JiraCredentialStore(jiraFile(dir), keyA).load()).toEqual(JIRA);
    expect(resolveJira(dir, undefined, keyA)).toEqual(JIRA);
  });
});

describe('git host tokens are sealed at rest', () => {
  it('set/get/list/remove round-trip through the sealed file; no token in the file or the list', () => {
    const dir = secretsDir();
    const s = new FileTokenStore(tokensFile(dir), keyA);
    s.set({ provider: 'gitlab', host: 'gitlab.com', token: 'GL-TOKEN-1' });
    s.set({ provider: 'bitbucket-cloud', host: 'bitbucket.org', token: 'BB-TOKEN-2', user: 'me@acme.com' });
    s.set({ provider: 'azure-devops', host: 'dev.azure.com', token: 'AZ-TOKEN-ACME', organization: 'acme' });
    s.set({
      provider: 'azure-devops',
      host: 'dev.azure.com',
      token: 'AZ-TOKEN-OTHER',
      organization: 'other',
    });
    isEnvelope(tokensFile(dir));
    const raw = readFileSync(tokensFile(dir), 'utf8');
    for (const t of TOKENS.slice(0, 4)) expect(raw).not.toContain(t);
    const fresh = new FileTokenStore(tokensFile(dir), keyA);
    expect(fresh.get('gitlab', 'gitlab.com')?.token).toBe('GL-TOKEN-1');
    expect(fresh.get('bitbucket-cloud', 'bitbucket.org')?.token).toBe('BB-TOKEN-2');
    expect(fresh.get('azure-devops', 'dev.azure.com', 'acme')?.token).toBe('AZ-TOKEN-ACME');
    expect(fresh.get('azure-devops', 'dev.azure.com', 'other')?.token).toBe('AZ-TOKEN-OTHER');
    expect(fresh.list()).toHaveLength(4);
    expect(JSON.stringify(fresh.list())).not.toMatch(/TOKEN/);
    expect(fresh.problem()).toBeUndefined();
    expect(fresh.remove('gitlab', 'gitlab.com')).toBe(true);
    expect(fresh.get('gitlab', 'gitlab.com')).toBeUndefined();
    expect(fresh.list()).toHaveLength(3);
  });
});

describe('plaintext files from an older runner are migrated on first read', () => {
  const writeLegacy = (dir: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(jiraFile(dir), JSON.stringify(JIRA, null, 2), { mode: 0o600 });
    const tokens = {
      'azure-devops@dev.azure.com': {
        provider: 'azure-devops',
        host: 'dev.azure.com',
        token: 'OLD-AZ-TOKEN',
        organization: 'acme',
        savedAt: '2026-01-01T00:00:00.000Z',
      },
      'gitlab@gitlab.com': { provider: 'gitlab', host: 'gitlab.com', token: 'OLD-GL-TOKEN', savedAt: 'x' },
      junk: { not: 'a token' },
    };
    writeFileSync(tokensFile(dir), JSON.stringify(tokens, null, 2), { mode: 0o600 });
    // a leftover temp file of the old plaintext store, after a crash
    writeFileSync(`${tokensFile(dir)}.tmp`, JSON.stringify(tokens), { mode: 0o600 });
  };

  it('seals both files in place, leaves no plaintext and does not rewrite on the next start', () => {
    const dir = secretsDir();
    writeLegacy(dir);

    expect(new JiraCredentialStore(jiraFile(dir), keyA).load()).toEqual(JIRA);
    const tokens = new FileTokenStore(tokensFile(dir), keyA);
    expect(tokens.get('azure-devops', 'dev.azure.com', 'acme')?.token).toBe('OLD-AZ-TOKEN');
    expect(tokens.get('gitlab', 'gitlab.com')?.token).toBe('OLD-GL-TOKEN');

    isEnvelope(jiraFile(dir));
    isEnvelope(tokensFile(dir));
    expect(existsSync(`${tokensFile(dir)}.tmp`)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['git-tokens.json', 'jira.json']);
    const all = everything(dir);
    for (const s of [JIRA.apiToken, JIRA.email, 'OLD-AZ-TOKEN', 'OLD-GL-TOKEN']) expect(all).not.toContain(s);

    // a second start: reads the envelope and writes nothing (a rewrite would change the random IV)
    const jiraBytes = readFileSync(jiraFile(dir), 'utf8');
    const tokenBytes = readFileSync(tokensFile(dir), 'utf8');
    expect(resolveJira(dir, undefined, keyA)).toEqual(JIRA);
    const again = new FileTokenStore(tokensFile(dir), keyA);
    expect(again.get('azure-devops', 'dev.azure.com', 'acme')?.token).toBe('OLD-AZ-TOKEN');
    expect(again.list()).toHaveLength(2);
    expect(readFileSync(jiraFile(dir), 'utf8')).toBe(jiraBytes);
    expect(readFileSync(tokensFile(dir), 'utf8')).toBe(tokenBytes);
  });
});

describe('a sealed file that cannot be opened', () => {
  it('git tokens: reports a reconnect problem, never throws, never wipes and keeps the old file aside', () => {
    const dir = secretsDir();
    new FileTokenStore(tokensFile(dir), keyA).set({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 'GL-TOKEN-1',
    });
    new JiraCredentialStore(jiraFile(dir), keyA).save(JIRA);
    const before = readFileSync(tokensFile(dir), 'utf8');

    const warnings: string[] = [];
    const wrong = new FileTokenStore(tokensFile(dir), keyB, { warn: (m) => warnings.push(m) });
    expect(wrong.get('gitlab', 'gitlab.com')).toBeUndefined();
    expect(wrong.list()).toEqual([]);
    expect(wrong.problem()).toBe(TOKENS_UNREADABLE);
    expect(TOKENS_UNREADABLE).toMatch(/again/);
    expect(warnings).toEqual([TOKENS_UNREADABLE]); // once, not on every read
    expect(wrong.remove('gitlab', 'gitlab.com')).toBe(false);
    expect(readFileSync(tokensFile(dir), 'utf8')).toBe(before);

    // connecting again moves the unreadable file aside (still sealed) and starts a new one
    wrong.set({ provider: 'bitbucket-cloud', host: 'bitbucket.org', token: 'BB-TOKEN-2' });
    const aside = readdirSync(dir).filter((f) => f.startsWith('git-tokens.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), 'utf8')).toBe(before);
    expect(wrong.problem()).toBeUndefined();
    expect(wrong.list().map((t) => t.provider)).toEqual(['bitbucket-cloud']);
    // the old file still opens with the old key once it is put back under its name
    const restored = join(mkdtempSync(join(tmp(), 'restore-')), 'git-tokens.json');
    copyFileSync(join(dir, aside[0] as string), restored);
    expect(new FileTokenStore(restored, keyA).get('gitlab', 'gitlab.com')?.token).toBe('GL-TOKEN-1');

    // the Jira store is not affected
    expect(new JiraCredentialStore(jiraFile(dir), keyA).load()).toEqual(JIRA);
    for (const w of warnings) {
      expect(w).not.toContain('GL-TOKEN-1');
      expect(w).not.toContain('BB-TOKEN-2');
    }
  });

  it('gitlab status shows the reconnect message', async () => {
    const dir = secretsDir();
    new FileTokenStore(tokensFile(dir), keyA).set({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 'GL-TOKEN-1',
    });
    const env: ForgeEnv = {
      exec: { run: async () => ({ exitCode: 127, stdout: '', stderr: '' }) },
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      tokens: new FileTokenStore(tokensFile(dir), keyB),
      processEnv: {},
    };
    const st = await new GitLabForge(env, 'gitlab.com').status();
    expect(st.state).toBe('not_connected');
    expect(st.detail).toBe(TOKENS_UNREADABLE);
  });

  it('Jira: no fallback to config.json, a reconnect status, and a new connect keeps the old file aside', async () => {
    const dir = secretsDir();
    new JiraCredentialStore(jiraFile(dir), keyA).save(JIRA);
    new FileTokenStore(tokensFile(dir), keyA).set({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 'GL-TOKEN-1',
    });
    const fromConfig = { baseUrl: 'https://old.example', apiToken: 'OLD-CONFIG-TOKEN' };

    const wrong = new JiraCredentialStore(jiraFile(dir), keyB);
    expect(wrong.load()).toBeUndefined();
    expect(wrong.problem()).toBe(JIRA_UNREADABLE);
    expect(JIRA_UNREADABLE).toMatch(/Connect Jira again/);
    expect(resolveJira(dir, fromConfig, keyB)).toBeUndefined();
    expect(resolveJira(secretsDir(), fromConfig, keyB)).toEqual(fromConfig); // no secrets file: config.json form

    const st = await new JiraIntegration(jiraEnv(dir, { sealKey: keyB })).status();
    expect(st.state).toBe('not_connected');
    expect(st.detail).toBe(JIRA_UNREADABLE);
    expect(JSON.stringify(st)).not.toContain(JIRA.apiToken);

    const before = readFileSync(jiraFile(dir), 'utf8');
    wrong.save({ ...JIRA, apiToken: 'JIRA-TOKEN-NEW' });
    unregisterSecret('JIRA-TOKEN-NEW');
    const aside = readdirSync(dir).filter((f) => f.startsWith('jira.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), 'utf8')).toBe(before);
    expect(wrong.load()?.apiToken).toBe('JIRA-TOKEN-NEW');
    unregisterSecret('JIRA-TOKEN-NEW');

    // the git tokens are not affected
    expect(new FileTokenStore(tokensFile(dir), keyA).get('gitlab', 'gitlab.com')?.token).toBe('GL-TOKEN-1');
  });

  it('a damaged file is reported the same way', () => {
    const dir = secretsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(jiraFile(dir), '{not json');
    writeFileSync(tokensFile(dir), '[1,2]');
    expect(new JiraCredentialStore(jiraFile(dir), keyA).problem()).toBe(JIRA_UNREADABLE);
    expect(new FileTokenStore(tokensFile(dir), keyA).problem()).toBe(TOKENS_UNREADABLE);
  });
});

describe.skipIf(process.platform === 'win32')('permissions', () => {
  it('sealed and quarantined files are 0600 in a 0700 directory', () => {
    const dir = secretsDir();
    new JiraCredentialStore(jiraFile(dir), keyA).save(JIRA);
    const s = new FileTokenStore(tokensFile(dir), keyA);
    s.set({ provider: 'gitlab', host: 'gitlab.com', token: 'GL-TOKEN-1' });
    new FileTokenStore(tokensFile(dir), keyB).set({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 'OLD-GL-TOKEN',
    });
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).some((f) => f.includes('.unreadable-'))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('tokens loaded from the sealed files are redacted', () => {
  it('after a sealed read', () => {
    const dir = secretsDir();
    new JiraCredentialStore(jiraFile(dir), keyA).save(JIRA);
    new FileTokenStore(tokensFile(dir), keyA).set({
      provider: 'gitlab',
      host: 'gitlab.com',
      token: 'GL-TOKEN-1',
    });
    unregisterSecret(JIRA.apiToken);
    unregisterSecret('GL-TOKEN-1');
    expect(redact(`x ${JIRA.apiToken} y`)).toContain(JIRA.apiToken); // nothing registered yet

    new JiraCredentialStore(jiraFile(dir), keyA).load();
    new FileTokenStore(tokensFile(dir), keyA).get('gitlab', 'gitlab.com');
    expect(redact(`x ${JIRA.apiToken} y`)).not.toContain(JIRA.apiToken);
    expect(redact(`clone with GL-TOKEN-1 now`)).not.toContain('GL-TOKEN-1');
  });

  it('after a migration read of plaintext files', () => {
    const dir = secretsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(jiraFile(dir), JSON.stringify(JIRA));
    writeFileSync(
      tokensFile(dir),
      JSON.stringify({
        'gitlab@gitlab.com': { provider: 'gitlab', host: 'gitlab.com', token: 'OLD-GL-TOKEN', savedAt: 'x' },
      }),
    );
    resolveJira(dir, undefined, keyA);
    new FileTokenStore(tokensFile(dir), keyA).list();
    expect(redact(`x ${JIRA.apiToken} y`)).not.toContain(JIRA.apiToken);
    expect(redact('x OLD-GL-TOKEN y')).not.toContain('OLD-GL-TOKEN');
  });
});

describe('the existing sealed-file users are unchanged', () => {
  it('load() returns undefined for a plaintext file and does not rewrite it', () => {
    const dir = secretsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'relay-whatsapp.json');
    const plain = JSON.stringify({ token: 'x' });
    writeFileSync(file, plain);
    const sf = new SealedFile(file, keyA, z.object({ token: z.string() }));
    expect(sf.load()).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(plain);
    expect(sf.open()).toEqual({ state: 'unreadable', reason: 'damaged' });
    expect(new SealedFile(join(dir, 'none.json'), keyA, z.object({})).open()).toEqual({ state: 'missing' });
  });
});
