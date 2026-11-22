import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupOffersWireSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../src/policy/schema.ts';
import { applyChoices, applyEdit, editableKeys, initialChoices, resolveOrgs } from '../src/setup/choices.ts';
import { readAllOffers, recordSetupOffer, writeOffers } from '../src/setup/offers.ts';
import { parseSetupOptions, type RawSetupFlags } from '../src/setup/options.ts';
import type { Prompter } from '../src/setup/prompt.ts';
import { renderScreen, runScreen, SCREEN_PROMPT } from '../src/setup/screen.ts';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
const orgs = [
  { orgId: ORG_A, orgName: 'Acme Law', role: 'Owner', devopsAgentId: AGENT_A, devopsAgentName: 'Dana' },
  { orgId: ORG_B, orgName: 'Smith & Co', role: 'Member', devopsAgentId: AGENT_B, devopsAgentName: 'Sam' },
  { orgId: ORG_C, orgName: 'Gamma', role: 'Admin' },
];
const repos = [{ url: 'https://github.com/acme/website.git', name: 'acme-website' }];
const opts = (raw: RawSetupFlags = {}) => parseSetupOptions(raw, {});
const policy = (over: Partial<Policy> = {}): Policy => ({ ...structuredClone(DEFAULT_POLICY), ...over });
const init = (raw: RawSetupFlags = {}, current = policy(), platform: NodeJS.Platform = 'linux') =>
  initialChoices({ current, orgs, repos, opts: opts(raw), platform });

describe('the one screen: choices model', () => {
  it('safe defaults: every organisation No, ask first, own Docker, ask before publishing, no scripts, yt-dlp Yes', () => {
    const c = init();
    expect(c.orgs.map((o) => [o.key, o.allow])).toEqual([
      ['1a', false],
      ['1b', false],
      ['1c', false],
    ]);
    expect(c).toMatchObject({ devopsRequests: 'ask', docker: 'rootless', deploy: 'ask', ytdlp: true });
    expect(c.repos).toEqual([
      { key: '5a', id: 'github.com/acme/website', name: 'acme-website', allow: false },
    ]);
    expect(init({}, policy(), 'darwin').docker).toBe('none');
    const mac = (interactive: boolean) =>
      initialChoices({
        current: policy(),
        orgs,
        repos,
        opts: opts({ dockerFound: 'desktop', dockerSocket: '/Users/a/.docker/run/docker.sock' }),
        platform: 'darwin',
        interactive,
      }).docker;
    expect(mac(true)).toBe('host');
    expect(mac(false)).toBe('none');
    expect(init({}, policy(), 'win32').docker).toBe('none');
  });

  it('every edit changes exactly its item; an organisation without a helper cannot be chosen', () => {
    let c = init();
    c = applyEdit(c, '1a', true);
    c = applyEdit(c, '2', 'auto');
    c = applyEdit(c, '3', 'none');
    c = applyEdit(c, '4', 'off');
    c = applyEdit(c, '5a', true);
    c = applyEdit(c, '6', false);
    expect(c.orgs.map((o) => o.allow)).toEqual([true, false, false]);
    expect(c).toMatchObject({ devopsRequests: 'auto', docker: 'none', deploy: 'off', ytdlp: false });
    expect(c.repos[0]?.allow).toBe(true);
    expect(() => applyEdit(c, '1c', true)).toThrow(/no DevOps helper/);
    expect(() => applyEdit(c, '3', 'shared')).toThrow(/not an item/);
    expect(() => applyEdit(c, '9', true)).toThrow(/not an item/);
    const next = policy();
    applyChoices(c, next);
    expect(next.devops.agents).toEqual({ [ORG_A]: AGENT_A });
    expect(next).toMatchObject({ devopsRequests: 'auto', deploy: 'off' });
    expect(next.installScripts).toEqual({ 'github.com/acme/website': true });
  });

  it('names map to ids: exact, case-insensitive; unknown and ambiguous names stop', () => {
    expect(resolveOrgs(['acme law'], orgs).map((o) => o.orgId)).toEqual([ORG_A]);
    expect(resolveOrgs([ORG_B.toUpperCase()], orgs).map((o) => o.orgId)).toEqual([ORG_B]);
    expect(() => resolveOrgs(['Acme'], orgs)).toThrow(/not one the server offers/);
    expect(() => resolveOrgs(['Gamma'], orgs)).toThrow(/no DevOps engineer/);
    const twins = [
      ...orgs,
      { orgId: randomUUID(), orgName: 'ACME LAW', role: 'Member', devopsAgentId: randomUUID() },
    ];
    expect(() => resolveOrgs(['Acme Law'], twins)).toThrow(/more than one/);
  });

  it('--yes with each flag', () => {
    const c = init({
      yes: true,
      devopsOrgs: 'Acme Law,Smith & Co',
      devopsRequests: 'auto',
      docker: 'none',
      deploy: 'off',
      allowScripts: 'acme-website',
      ytdlp: false,
    });
    expect(c.orgs.filter((o) => o.allow).map((o) => o.orgId)).toEqual([ORG_A, ORG_B]);
    expect(c).toMatchObject({ devopsRequests: 'auto', docker: 'none', deploy: 'off', ytdlp: false });
    expect(c.repos[0]?.allow).toBe(true);
    expect(() => init({ allowScripts: 'https://github.com/other/repo' })).toThrow(/not a repository/);
    // a password is refused and never echoed back
    let msg = '';
    try {
      init({ allowScripts: 'https://alice:s3cret@github.com/acme/website.git' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/with a password is refused/);
    expect(msg).not.toContain('s3cret');
    expect(() => opts({ devopsOrgs: 'owned' })).toThrow(/no shortcuts/);
    expect(() => opts({ devopsRequests: 'maybe' })).toThrow(/devops-requests/);
    expect(() => opts({ wslDistroName: 'bad name' })).toThrow(/wsl-distro-name/);
    expect(parseSetupOptions({}, { GUILDWISE_WITH_YTDLP: 'n' }).withYtdlp).toBe(false);
    expect(parseSetupOptions({}, { GUILDWISE_DEVOPS_REQUESTS: 'auto' }).devopsRequests).toBe('auto');
  });

  it('[S4] a re-run starts from the policy: grants stay, --yes revokes nothing, only none or an edit removes one', () => {
    const current = policy({
      devops: { agents: { [ORG_A]: AGENT_A, [randomUUID()]: randomUUID() } },
      devopsRequests: 'auto',
      deploy: 'off',
      docker: 'none',
      setupDone: true,
      installScripts: { 'github.com/acme/website': true, 'github.com/kept/other': true },
    });
    const c = init({ yes: true }, current);
    const next = structuredClone(current);
    applyChoices(c, next);
    expect(next.devops.agents).toEqual(current.devops.agents);
    expect(next).toMatchObject({ devopsRequests: 'auto', deploy: 'off' });
    expect(c.docker).toBe('none');
    expect(next.installScripts).toEqual(current.installScripts);
    const none = init({ yes: true, devopsOrgs: 'none' }, current);
    const n2 = structuredClone(current);
    applyChoices(none, n2);
    expect(n2.devops.agents).toEqual({});
    const edited = applyEdit(c, '1a', false);
    const n3 = structuredClone(current);
    applyChoices(edited, n3);
    expect(Object.keys(n3.devops.agents)).not.toContain(ORG_A);
  });

  it('hides items 1 and 5 when nothing is offered', () => {
    const c = initialChoices({ current: policy(), orgs: [], repos: [], opts: opts(), platform: 'linux' });
    const text = renderScreen(c).join('\n');
    expect(text).not.toContain('DevOps helpers that may work');
    expect(text).not.toContain('Install scripts');
    expect(editableKeys(c)).toEqual(['2', '3', '4', '6']);
  });
});

describe('the one screen: text and edits', () => {
  it('shows the exact design text with names and the helper', () => {
    const lines = renderScreen(init());
    expect(lines[0]).toBe('Almost done. Here is what this computer will allow.');
    const text = lines.join('\n');
    expect(text).toMatch(/ {6}1a {2}Acme Law \(you are Owner\), helper "Dana" \.+ No/);
    expect(text).toMatch(/ {6}1b {2}Smith & Co \(you are Member\), helper "Sam" \.+ No/);
    expect(text).toMatch(/ 2 {2}When the website asks a DevOps helper for something \.+ Ask me first/);
    expect(text).toMatch(/ 3 {2}Docker, for apps your agents build and test \.+ Its own private Docker/);
    expect(text).toMatch(/ 4 {2}Publishing your apps \.+ Ask me first/);
    expect(text).toMatch(/ {6}5a {2}acme-website \(github.com\/acme\/website\) \.+ No/);
    expect(text).toMatch(/ 6 {2}Video transcripts \(yt-dlp, in the runner's own folder\) \.+ Yes/);
    expect(text).not.toContain(ORG_A);
  });

  it('Enter accepts; a typed number asks that item and loops back', async () => {
    const typed = ['1a', '7', '6', ''];
    const asked: string[] = [];
    const p: Prompter = {
      async text(q) {
        expect(q).toBe(SCREEN_PROMPT);
        return typed.shift() ?? '';
      },
      async confirm(q, d) {
        asked.push(q);
        if (/Acme Law's DevOps helper "Dana"/.test(q)) return true;
        if (/Install yt-dlp/.test(q)) return false;
        return d;
      },
      async choose(_q, _c, d) {
        return d;
      },
      async secret() {
        return '';
      },
    };
    const said: string[] = [];
    const c = await runScreen(init(), p, (l) => said.push(l));
    expect(c.orgs[0]?.allow).toBe(true);
    expect(c.ytdlp).toBe(false);
    expect(said.join('\n')).toContain('There is no item 7 to change');
    expect(asked[0]).toContain('Each task still asks you first unless you change item 2.');
  });
});

describe('setup offers from the server', () => {
  it('names with control characters or ANSI escapes are refused [S2]', () => {
    const bad = { orgs: [{ orgId: ORG_A, orgName: 'Acme\u001b[31m', role: 'Owner' }], repos: [] };
    expect(SetupOffersWireSchema.safeParse(bad).success).toBe(false);
    // bidi controls could reorder the installer screen (review nit): refused too; plain accents and emoji pass
    const rlo = { orgs: [{ orgId: ORG_A, orgName: 'Acme \u202Ewal', role: 'Owner' }], repos: [] };
    expect(SetupOffersWireSchema.safeParse(rlo).success).toBe(false);
    const fine = { orgs: [{ orgId: ORG_A, orgName: 'Café Müller 👩‍⚖️', role: 'Owner' }], repos: [] };
    expect(SetupOffersWireSchema.safeParse(fine).success).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'gw-offers-'));
    writeFileSync(
      join(dir, 'setup-offers.json'),
      JSON.stringify({
        orgs: [bad.orgs[0], { orgId: ORG_B, orgName: 'Fine', role: 'Owner' }],
        repos: [{ url: 'https://x.example/a', name: 'a\u0007' }],
      }),
    );
    const read = readAllOffers([dir]);
    expect(read.orgs.map((o) => o.orgName)).toEqual(['Fine']);
    expect(read.repos).toEqual([]);
    const withPw = mkdtempSync(join(tmpdir(), 'gw-offers-'));
    writeFileSync(
      join(withPw, 'setup-offers.json'),
      JSON.stringify({ orgs: [], repos: [{ url: 'https://u:s3cret@github.com/a/b', name: 'b' }] }),
    );
    expect(readAllOffers([withPw]).repos).toEqual([]);
  });

  it('pair writes the offers (mode 600) and welcome refreshes them; a refused-shift placeholder never replaces a name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-offers-'));
    expect(writeOffers(dir, { orgs: [orgs[0] as never], repos })).toBe(true);
    expect(statSync(join(dir, 'setup-offers.json')).mode & 0o777).toBe(0o600);
    expect(writeOffers(dir, { orgs: [orgs[0] as never], repos })).toBe(false);
    expect(writeOffers(dir, { orgs: [orgs[0] as never, orgs[1] as never], repos: [] })).toBe(true);
    expect(readAllOffers([dir]).orgs.map((o) => o.orgName)).toEqual(['Acme Law', 'Smith & Co']);
    expect(
      recordSetupOffer(dir, {
        orgId: ORG_A,
        orgName: 'organization 1234',
        role: 'unknown',
        devopsAgentId: AGENT_A,
      }),
    ).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'setup-offers.json'), 'utf8')).orgs[0].orgName).toBe('Acme Law');
  });
});

describe('item 6: yt-dlp from setup, in the runner home only', () => {
  it('runs installExtra when Yes, prints the command when it fails, skips when No', async () => {
    const { runSetup } = await import('../src/setup/setup.ts');
    const home = mkdtempSync(join(tmpdir(), 'gw-setup6-'));
    const out: string[] = [];
    const calls: string[] = [];
    const deps = {
      home,
      uid: 990,
      username: 'guildwise-runner',
      platform: 'linux' as const,
      dataRoot: join(home, '.aom-runner'),
      prompter: null,
      out: (l: string) => out.push(l),
      exec: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      installExtra: async (n: 'yt-dlp') => {
        calls.push(n);
        return { ok: false, detail: 'checksum mismatch' };
      },
    };
    await runSetup(deps, opts({ yes: true }));
    expect(calls).toEqual(['yt-dlp']);
    expect(out.join('\n')).toContain(
      'yt-dlp not installed: checksum mismatch. Later: sudo -u guildwise-runner -H ',
    );
    calls.length = 0;
    await runSetup(deps, opts({ yes: true, ytdlp: false }));
    expect(calls).toEqual([]);
  });
});
