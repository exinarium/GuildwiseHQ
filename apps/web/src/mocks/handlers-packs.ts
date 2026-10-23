import { HttpResponse, http } from 'msw';

/** Mock server for Capabilities (VITE_MSW=1 dev): a built-in registry, and one pack that starts untrusted with a script file. */
const A = '/api';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HASH = 'f'.repeat(64);
const PACK_ID = '00000000-0000-4000-8000-0000000000c1';
const hash = '0'.repeat(64);

const state = { trusted: false, scripts: false, removed: false };

const packItems = () => [
  {
    kind: 'persona',
    key: 'bmad:analyst',
    name: 'Mary, Analyst',
    description: 'Business analyst who digs into the problem first.',
    hash,
    source: 'pack',
    pack: 'bmad',
    icon: '📊',
    tags: [],
    hasScripts: false,
    files: [{ path: 'agents/analyst.md', size: 2200, script: false, hash: 'aaaaaaaaaaaa' }],
  },
  {
    kind: 'playbook',
    key: 'bmad:brainstorming',
    name: 'Brainstorming',
    description: 'Guided brainstorming techniques.',
    hash,
    source: 'pack',
    pack: 'bmad',
    tags: ['discovery'],
    hasScripts: true,
    files: [
      { path: 'brainstorming/workflow.md', size: 4100, script: false, hash: 'bbbbbbbbbbbb' },
      { path: 'brainstorming/scripts/pick.py', size: 600, script: true, hash: 'cccccccccccc' },
    ],
  },
];

const packDto = () => ({
  id: PACK_ID,
  name: 'bmad',
  url: 'https://github.com/bmad-code-org/BMAD-METHOD.git',
  ref: 'v6.12.4',
  adapter: 'bmad',
  scope: 'org',
  projectId: null,
  preset: 'bmad',
  status: 'ready',
  error: null,
  pinnedSha: SHA,
  contentHash: HASH,
  trusted: state.trusted,
  trustedSha: state.trusted ? SHA : null,
  scriptsEnabled: state.scripts,
  hasScripts: true,
  license: 'MIT',
  integrityFailed: false,
  itemCount: 2,
  update: null,
  lastCheckedAt: null,
  addedAt: new Date().toISOString(),
  attribution:
    'BMad Method, by BMad Code, LLC (github.com/bmad-code-org/BMAD-METHOD), MIT licence. Imported as an optional pack; not part of Guildwise.',
});

export const packHandlers = [
  http.get(`${A}/capabilities`, ({ request }) => {
    const kind = new URL(request.url).searchParams.get('kind');
    const usable = new URL(request.url).searchParams.get('usable') === 'true';
    const builtin = [
      {
        kind: 'persona',
        key: 'devils-advocate',
        name: "Devil's advocate",
        description: 'Challenges assumptions.',
        hash,
        source: 'builtin',
        overrides: false,
        usable: true,
      },
      {
        kind: 'skill',
        key: 'git',
        name: 'Git',
        description: 'Use git safely.',
        hash,
        source: 'builtin',
        overrides: false,
        usable: true,
      },
    ];
    const pack = state.removed
      ? []
      : packItems().map((i) => ({
          ...i,
          overrides: false,
          usable: state.trusted,
          ...(state.trusted ? {} : { unusableReason: 'untrusted' }),
          packId: PACK_ID,
        }));
    const items = [...builtin, ...pack].filter((i) => (!kind || i.kind === kind) && (!usable || i.usable));
    return HttpResponse.json({ items, issues: [], indexedAt: null });
  }),
  http.get(`${A}/packs`, () =>
    HttpResponse.json({ packs: state.removed ? [] : [packDto()], workstationsOnline: 1 }),
  ),
  http.get(`${A}/packs/:id`, () =>
    HttpResponse.json({
      pack: {
        ...packDto(),
        updateSnapshot: null,
        snapshot: {
          ref: 'v6.12.4',
          sha: SHA,
          contentHash: HASH,
          adapter: 'bmad',
          items: packItems(),
          issues: [],
          notes: ['bmad-party-mode: not imported, the Boardroom replaces it'],
          license: 'MIT',
          hasScripts: true,
        },
      },
    }),
  ),
  http.post(`${A}/packs/:id/trust`, () => {
    state.trusted = true;
    return HttpResponse.json({ pack: packDto() });
  }),
  http.post(`${A}/packs/:id/revoke`, () => {
    state.trusted = false;
    state.scripts = false;
    return HttpResponse.json({ pack: packDto() });
  }),
  http.post(`${A}/packs/:id/scripts`, async ({ request }) => {
    state.scripts = ((await request.json()) as { enabled: boolean }).enabled;
    return HttpResponse.json({ pack: packDto() });
  }),
  http.post(`${A}/packs/:id/check`, () => HttpResponse.json({ ok: true }, { status: 202 })),
  http.delete(`${A}/packs/:id`, () => {
    state.removed = true;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${A}/packs`, () => {
    state.removed = false;
    return HttpResponse.json({ pack: packDto() }, { status: 201 });
  }),
];
