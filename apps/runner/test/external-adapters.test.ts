import { parseExternalRef } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { defaultExec } from '../src/external/github.ts';
import {
  type Exec,
  ExternalAdapters,
  formatSource,
  GithubAdapter,
  JiraAdapter,
  SourceReadError,
} from '../src/external/index.ts';

const issue = {
  title: 'Add dark mode',
  body: 'Users want a dark theme.',
  state: 'OPEN',
  url: 'https://github.com/acme/toy/issues/12',
  labels: [{ name: 'enhancement' }, { name: 'ui' }],
  comments: [{ author: { login: 'octo' }, body: 'Agreed.\nSecond line', createdAt: '2026-10-01T10:00:00Z' }],
};

const fakeExec = (
  stdout: string,
  exitCode = 0,
  stderr = '',
): { exec: Exec; calls: Array<{ bin: string; args: string[] }> } => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  return {
    calls,
    exec: async (bin, args) => {
      calls.push({ bin, args });
      return { exitCode, stdout, stderr };
    },
  };
};

describe('GitHub adapter (gh issue view --json on the runner)', () => {
  it('reads an issue through gh with the repo and number from the key', async () => {
    const f = fakeExec(JSON.stringify(issue));
    const src = await new GithubAdapter({ exec: f.exec }).readSource({
      system: 'github',
      key: 'acme/toy#12',
    });
    expect(f.calls).toEqual([
      {
        bin: 'gh',
        args: ['issue', 'view', '12', '--repo', 'acme/toy', '--json', 'title,body,state,url,labels,comments'],
      },
    ]);
    expect(src).toMatchObject({
      ref: { system: 'github', key: 'acme/toy#12' },
      title: 'Add dark mode',
      body: 'Users want a dark theme.',
      status: 'OPEN',
      labels: ['enhancement', 'ui'],
      comments: [{ author: 'octo', body: 'Agreed.\nSecond line' }],
    });
    expect(formatSource(src)).toContain('acme/toy#12: Add dark mode');
    expect(formatSource(src)).toContain('- octo (2026-10-01T10:00:00Z): Agreed.\n  Second line');
  });

  it('uses the configured gh binary', async () => {
    const f = fakeExec(JSON.stringify(issue));
    await new GithubAdapter({ bin: '/opt/gh', exec: f.exec }).readSource({
      system: 'github',
      key: 'acme/toy#1',
    });
    expect(f.calls[0]?.bin).toBe('/opt/gh');
  });

  it('fails clearly: bad key, gh failing, gh not installed, not JSON', async () => {
    const a = (e: Exec) => new GithubAdapter({ exec: e });
    await expect(a(fakeExec('{}').exec).readSource({ system: 'github', key: 'ABC-1' })).rejects.toThrow(
      /not a GitHub issue reference/,
    );
    await expect(
      a(fakeExec('', 1, 'Could not resolve to an Issue').exec).readSource({
        system: 'github',
        key: 'acme/toy#99',
      }),
    ).rejects.toThrow(/gh issue view failed: Could not resolve/);
    await expect(
      a(async () => {
        throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      }).readSource({ system: 'github', key: 'acme/toy#1' }),
    ).rejects.toThrow(/is not installed/);
    await expect(
      a(fakeExec('nope').exec).readSource({ system: 'github', key: 'acme/toy#1' }),
    ).rejects.toThrow(/not JSON/);
  });
});

describe('the default exec', () => {
  it('reports a missing binary as ENOENT (so the adapter says gh is not installed)', async () => {
    await expect(defaultExec('aom-definitely-not-a-binary', [])).rejects.toMatchObject({ code: 'ENOENT' });
    const r = await defaultExec(process.execPath, ['-e', 'console.log("hi")']);
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hi' });
  });
});

describe('Jira adapter (the agent reads Jira with its own skill)', () => {
  it('tells the agent to use the Jira skill instead of holding credentials itself', async () => {
    const err = await new JiraAdapter().readSource({ system: 'jira', key: 'ABC-123' }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceReadError);
    expect(err.message).toMatch(/Jira skill/);
    expect(err.message).toMatch(/skills\/jira\.md/);
  });

  it('lets a runtime plug in a reader', async () => {
    const src = await new JiraAdapter({
      reader: async (ref) => ({ ref, title: 'T', body: 'B', labels: [], comments: [] }),
    }).readSource({ system: 'jira', key: 'ABC-1' });
    expect(src.title).toBe('T');
  });
});

describe('adapter registry', () => {
  it('routes a pasted reference to the right adapter', async () => {
    const f = fakeExec(JSON.stringify(issue));
    const adapters = ExternalAdapters.defaults({ exec: f.exec });
    const src = await adapters.readText('see https://github.com/acme/toy/issues/12');
    expect(src.ref.key).toBe('acme/toy#12');
    await expect(adapters.readText('ABC-5')).rejects.toThrow(/Jira skill/);
    await expect(adapters.readText('no ticket here')).rejects.toThrow(/does not look like/);
    expect(adapters.get('github')?.system).toBe('github');
    expect(parseExternalRef('ABC-5')?.system).toBe('jira');
  });
});
