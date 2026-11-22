import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assetSources, WINDOW_ASSETS } from '../src/window/server.ts';

/**
 * The approvals page's own files [S2]: text only (no innerHTML anywhere), no inline script, and no external URL in any
 * asset (no CDN, works offline). Rendering is checked by running window.js against a minimal DOM whose innerHTML throws:
 * a server-supplied name full of markup must come out as text, and no element the markup names is ever created.
 */

const here = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(p, 'utf8');
const js = read(join(here, 'src', 'window', 'static', 'window.js'));
const html = read(join(here, 'src', 'window', 'static', 'index.html'));

describe('page files', () => {
  it('window.js never parses markup', () => {
    for (const bad of [
      /innerHTML/,
      /outerHTML/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\(/,
      /new Function/,
      /DOMParser/,
      /setAttribute\(\s*['"](?:on|style|href|src)/,
      /localStorage|sessionStorage|document\.cookie/,
    ])
      expect(js, String(bad)).not.toMatch(bad);
  });

  it('index.html has no inline script, handler or style', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('no asset names an external URL (the SVG namespace is not a fetch)', () => {
    const sources = assetSources();
    expect(Object.keys(sources).sort()).toEqual(Object.keys(WINDOW_ASSETS).sort());
    for (const [url, file] of Object.entries(sources)) {
      expect(file, url).not.toBe('');
      if (file.endsWith('.woff2')) continue;
      const text = read(file).replaceAll('xmlns="http://www.w3.org/2000/svg"', '');
      expect(text, url).not.toMatch(/https?:\/\//i);
      expect(text, url).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
    }
  });

  it('the copy script publishes exactly the files the server serves', () => {
    const script = read(join(here, 'scripts', 'copy-window-assets.mjs'));
    const names = [...script.matchAll(/^\s+'([a-z0-9.-]+\.(?:html|js|css|svg|woff2))':/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.values(WINDOW_ASSETS).sort());
    expect(read(join(here, 'tsup.config.ts'))).toContain('node scripts/copy-window-assets.mjs');
    expect(read(join(here, 'THIRD_PARTY_NOTICES'))).toContain('SIL OPEN FONT LICENSE');
  });
});

// ---------------------------------------------------------------- a minimal DOM (innerHTML throws)

class FakeText {
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}
class FakeEl {
  childNodes: Array<FakeEl | FakeText> = [];
  attrs: Record<string, string> = {};
  className = '';
  checked = false;
  disabled = false;
  constructor(public tagName: string) {}
  appendChild<T extends FakeEl | FakeText>(n: T): T {
    this.childNodes.push(n);
    return n;
  }
  append(...ns: Array<FakeEl | FakeText | null>) {
    for (const n of ns) if (n) this.childNodes.push(n);
  }
  replaceChildren(...ns: Array<FakeEl | FakeText>) {
    this.childNodes = ns;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes = [new FakeText(String(v))];
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML used');
  }
}
const fakeDocument = {
  createElement: (t: string) => new FakeEl(t.toUpperCase()),
  createTextNode: (s: string) => new FakeText(s),
  getElementById: () => null,
};

function loadPage(): {
  renderState: (s: unknown) => FakeEl[];
  headerText: (h: unknown) => string;
  pairSteps: (p: unknown) => FakeEl[];
} {
  const sandbox: Record<string, unknown> = { document: fakeDocument };
  sandbox.self = sandbox;
  runInNewContext(js, sandbox);
  return sandbox.gwApprovals as never;
}

function walk(n: FakeEl | FakeText, out: { tags: string[]; texts: string[] }) {
  if (n instanceof FakeText) out.texts.push(n.data);
  else {
    out.tags.push(n.tagName);
    for (const c of n.childNodes) walk(c, out);
  }
  return out;
}

const EVIL = '<img src=x onerror=alert(1)>';

const stateFixture = {
  header: { instance: 'uat', warn: true, serverHost: 'uat.example.com' },
  status: {
    version: '1.10.0',
    servers: [{ origin: 'https://uat.example.com', host: 'uat.example.com', connected: true }],
    instance: 'uat',
    runnerUser: 'guildwise-runner-uat',
    docker: 'Its own private Docker',
    connected: true,
    shifts: [{ title: `Builder on ${EVIL}` }],
    setupDone: true,
    setupCommand: 'guildwise-runner setup',
  },
  waiting: [
    {
      id: 'abc123def0',
      kind: 'deploy.exec',
      what: 'Publish an app',
      summary: `Publish ${EVIL}`,
      detail: `<script>alert(1)</script>`,
      createdAt: '2026-11-21T10:00:00Z',
      expiresAt: '2026-11-22T10:00:00Z',
      canPin: true,
      command: 'guildwise-runner approve abc123def0',
    },
  ],
  allows: {
    devops: [
      {
        orgId: 'o1',
        orgName: EVIL,
        role: 'Owner',
        agentId: 'a1',
        agentName: `<b>Dana</b>`,
        granted: false,
      },
    ],
    devopsRequests: 'ask',
    repos: [{ url: 'https://github.com/acme/website', name: EVIL, allowed: false }],
    deploy: { mode: 'ask', pinCommit: false, pins: 0 },
    formatterPins: [],
    passkeys: {
      trusted: [],
      offered: [{ credentialId: 'c1', name: EVIL, createdAt: '2026-11-21T10:00:00Z' }],
    },
    readOnly: [{ label: 'Docker for your apps', value: EVIL, command: 'guildwise-runner setup' }],
  },
};

describe('rendering [S2]', () => {
  it('a name with markup renders as text, and no element it names is created', () => {
    const page = loadPage();
    const out = { tags: [] as string[], texts: [] as string[] };
    for (const el of page.renderState(stateFixture)) walk(el, out);
    expect(out.tags).not.toContain('IMG');
    expect(out.tags).not.toContain('SCRIPT');
    expect(out.tags).not.toContain('B');
    const text = out.texts.join('\n');
    expect(text).toContain(`Builder on ${EVIL}`);
    expect(text).toContain(`Publish ${EVIL}`);
    expect(text).toContain(`${EVIL}: let DevOps helper "<b>Dana</b>" work outside the safety box`);
    expect(text).toContain(`Let "${EVIL}" run its own install scripts`);
    expect(text).toContain('Waiting for your yes');
    expect(text).toContain('What this computer allows');
  });

  it('a stale DevOps grant shows plainly, with a one-click "Use the current helper" (UAT 1.10.0 finding 2)', () => {
    const page = loadPage();
    const state = structuredClone(stateFixture);
    state.allows.devops = [
      {
        orgId: 'o1',
        orgName: 'Acme Law',
        role: 'Owner',
        agentId: 'a-new',
        agentName: 'Forge',
        granted: false,
        grantedOther: true,
        grantedAgentId: '45236b3a-0000-7000-8000-000000000000',
      } as never,
    ];
    const out = { tags: [] as string[], texts: [] as string[] };
    for (const el of page.renderState(state)) walk(el, out);
    const text = out.texts.join('\n');
    expect(text).toContain('The permission for Acme Law still names an old DevOps helper (agent 45236b3a)');
    expect(text).toContain('Use the current helper');
    // without a stale grant there is no such notice
    const clean = { tags: [] as string[], texts: [] as string[] };
    for (const el of page.renderState(stateFixture)) walk(el, clean);
    expect(clean.texts.join('\n')).not.toContain('Use the current helper');
  });

  it('a DevOps request blocked by Install off is one card with the switch, a button and the command (UAT 1.10.0 finding 3)', () => {
    const page = loadPage();
    const state = structuredClone(stateFixture) as Record<string, any>;
    state.waiting = [];
    state.blocked = [
      {
        requestId: 'r1',
        switch: 'allowInstall',
        switchLabel: 'Install packages and tools',
        agentName: 'Forge',
        summary: 'install Node 22',
        at: '2026-11-22T10:00:00Z',
        command: '/home/guildwise-runner/.local/bin/guildwise-runner devops install on',
      },
    ];
    state.allows.devopsInstall = false;
    const out = { tags: [] as string[], texts: [] as string[] };
    for (const el of page.renderState(state)) walk(el, out);
    const text = out.texts.join('\n');
    expect(text).toContain('A DevOps request waits for a setting');
    expect(text).toContain('Forge needs "Install packages and tools" for: install Node 22');
    expect(text).toContain('Let DevOps helpers install tools');
    expect(text).toContain('guildwise-runner devops install on');
    expect(text).not.toContain('Nothing is waiting for your yes.');
    expect(text).toContain('Let DevOps helpers install the tools your projects need');
  });

  it('the header names the instance and the server host', () => {
    const page = loadPage();
    expect(page.headerText({ instance: 'uat', serverHost: 'uat.example.com' })).toBe(
      'Approvals on this computer · instance uat · uat.example.com',
    );
  });

  it('the pairing steps show the command and the fingerprint as text', () => {
    const page = loadPage();
    const out = { tags: [] as string[], texts: [] as string[] };
    for (const el of page.pairSteps({
      command: 'guildwise-runner approvals pair K7M2-Q9',
      fingerprint: '3fa9c210',
    }))
      walk(el, out);
    const text = out.texts.join('');
    expect(text).toContain('guildwise-runner approvals pair K7M2-Q9');
    expect(text).toContain('Fingerprint 3fa9c210');
  });
});
