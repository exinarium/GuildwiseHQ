import { describe, expect, it } from 'vitest';
import {
  AgentDraftSchema,
  availableStarters,
  builtinCapabilities,
  builtinPersonaText,
  clampDraft,
  draftFromPersonaText,
  draftRoleKey,
  FOLLOW_UP_DEFAULT_DAYS,
  followUpAction,
  mentionedHandles,
  mentionHandles,
  mentionQueryAt,
  mentionTaskPrompt,
  mentionToolsFor,
  parseAgentDraft,
  STARTER_GALLERY,
} from '../src/index.ts';

describe('mentions', () => {
  it('finds handles, once each, and skips e-mail addresses and trailing dashes', () => {
    expect(mentionedHandles('@Una please check, cc @una and @max-2. Mail una@example.com or a@@b')).toEqual([
      'una',
      'max-2',
    ]);
    expect(mentionedHandles('no mention here, 5@6')).toEqual([]);
    expect(mentionedHandles('(@una) and "@bo"')).toEqual(['una', 'bo']);
  });

  it('makes handles unique per agent', () => {
    const h = mentionHandles([
      { id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Una' },
      { id: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Max Power' },
      { id: '33333333-cccc-4ccc-8ccc-cccccccccccc', name: 'una!' },
    ]);
    expect(h.get('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe('max-power');
    expect(h.get('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('una-1111');
    expect(h.get('33333333-cccc-4ccc-8ccc-cccccccccccc')).toBe('una-3333');
  });

  it('finds the mention being typed at the caret', () => {
    expect(mentionQueryAt('hello @un', 9)).toEqual({ query: 'un', start: 6 });
    expect(mentionQueryAt('hello @', 7)).toEqual({ query: '', start: 6 });
    expect(mentionQueryAt('hello a@un', 10)).toBeNull();
    expect(mentionQueryAt('hello @un there', 15)).toBeNull();
  });

  it('frames the task as read-only and quotes the comment', () => {
    const p = mentionTaskPrompt({
      agentName: 'Una',
      commenterName: 'Pat',
      cardRef: 'TOY-1',
      cardTitle: 'Login',
      comment: '@una what is left?',
    });
    expect(p).toContain('Pat mentioned you in a comment on card TOY-1 "Login"');
    expect(p).toContain('cannot edit files, run commands');
    expect(p.endsWith('@una what is left?')).toBe(true);
  });

  it('tells an agent that may work what it may do, and a held-back one why it only reads', () => {
    const base = {
      agentName: 'Una',
      commenterName: 'Pat',
      cardRef: 'TOY-1',
      cardTitle: 'Login',
      comment: 'fix it',
    };
    const edit = mentionTaskPrompt({ ...base, access: { tools: ['edit', 'shell'], commit: false } });
    expect(edit).toContain('You may edit files and run commands in this card');
    expect(edit).toContain('Do not commit, push, merge');
    expect(edit).not.toContain('cannot edit files');
    expect(mentionTaskPrompt({ ...base, access: { tools: ['edit'], commit: true } })).toContain(
      'You may commit on the card branch',
    );
    const held = mentionTaskPrompt({ ...base, readOnlyReason: 'a shift holds this card right now' });
    expect(held).toContain('cannot edit files');
    expect(held).toContain('(a shift holds this card right now)');
  });

  it("gives a mention reading, and the role's edit and shell only when the commenter may grant them", () => {
    const role = ['read', 'edit', 'shell', 'web', 'mcp:github'];
    expect(mentionToolsFor(role, { work: false })).toEqual(['read']);
    expect(mentionToolsFor(role, { work: true })).toEqual(['read', 'edit', 'shell']);
    expect(mentionToolsFor(['read'], { work: true })).toEqual(['read']);
  });
});

describe('follow-up window', () => {
  const day = 86_400_000;
  const t0 = new Date('2026-01-10T09:00:00Z');
  const base = {
    openedAt: t0,
    lastNudgeAt: null,
    nudgeCount: 0,
    snoozedUntil: null,
    routedTo: 'manager' as const,
  };
  const at = (days: number) => new Date(t0.getTime() + days * day);

  it('nudges after N days, then waits another N', () => {
    expect(FOLLOW_UP_DEFAULT_DAYS).toBe(3);
    expect(followUpAction(base, at(2.9), 3)).toBeNull();
    expect(followUpAction(base, at(3), 3)).toBe('nudge');
    const nudged = { ...base, lastNudgeAt: at(3), nudgeCount: 1 };
    expect(followUpAction(nudged, at(3.1), 3)).toBeNull();
    expect(followUpAction(nudged, at(5.9), 3)).toBeNull();
    expect(followUpAction(nudged, at(6), 3)).toBe('nudge');
  });
  it('is off at 0 and held by a snooze, which then lets the next nudge through', () => {
    expect(followUpAction(base, at(30), 0)).toBeNull();
    const snoozed = { ...base, snoozedUntil: at(8) };
    expect(followUpAction(snoozed, at(7), 3)).toBeNull();
    expect(followUpAction(snoozed, at(8), 3)).toBe('nudge');
  });
  it('stops nudging after three nudges in all', () => {
    const third = { ...base, lastNudgeAt: at(9), nudgeCount: 3 };
    expect(followUpAction({ ...base, lastNudgeAt: at(6), nudgeCount: 2 }, at(9), 3)).toBe('nudge');
    expect(followUpAction(third, at(30), 3)).toBeNull();
  });
  it('re-queues an agent’s item once', () => {
    const agent = { ...base, routedTo: 'agent' as const };
    expect(followUpAction(agent, at(2), 3)).toBeNull();
    expect(followUpAction(agent, at(3), 3)).toBe('requeue');
    expect(followUpAction({ ...agent, lastNudgeAt: at(3), nudgeCount: 1 }, at(20), 3)).toBeNull();
  });
});

describe('agent draft', () => {
  const draft = {
    name: 'Penny',
    purpose: 'Writes release notes.',
    instructions: 'You write release notes for customers from the list of merged changes you are given.',
    tools: ['read', 'shell', 'teleport'],
    model: 'HAIKU',
    skills: ['a', 3],
    playbooks: ['release-notes'],
  };

  it('reads the reply from a fenced block or from text around it, dropping what is unknown', () => {
    for (const text of [
      JSON.stringify(draft),
      `Sure.\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\nDone.`,
      `Here: ${JSON.stringify(draft)} bye`,
    ]) {
      const r = parseAgentDraft(text);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.draft).toMatchObject({
          name: 'Penny',
          model: 'haiku',
          tools: ['read', 'shell'],
          skills: ['a'],
          playbooks: ['release-notes'],
        });
      }
    }
  });
  it('names what is missing', () => {
    expect(parseAgentDraft('I would like more detail.')).toEqual({
      ok: false,
      error: 'the reply held no draft',
    });
    expect(parseAgentDraft('{"name": "x"')).toMatchObject({ ok: false });
    expect(parseAgentDraft(JSON.stringify({ ...draft, instructions: 'short' }))).toEqual({
      ok: false,
      error: 'the draft is missing instructions',
    });
    expect(parseAgentDraft(JSON.stringify({ ...draft, name: '' }))).toEqual({
      ok: false,
      error: 'the draft is missing name',
    });
  });
  it('braces inside strings do not end the object', () => {
    const r = parseAgentDraft(JSON.stringify({ ...draft, purpose: 'Handles {curly} text and "quotes"' }));
    expect(r.ok && r.draft.purpose).toBe('Handles {curly} text and "quotes"');
  });
  it('clamps tools to the hirer', () => {
    const d = AgentDraftSchema.parse({
      ...draft,
      skills: [],
      tools: ['read', 'edit', 'shell', 'web'],
      model: 'sonnet',
    });
    expect(clampDraft(d, { mayWiden: true }).permissions.allowedTools).toEqual([
      'read',
      'edit',
      'shell',
      'web',
    ]);
    const m = clampDraft(d, { mayWiden: false });
    expect(m.permissions.allowedTools).toEqual(['read']);
    expect(m.permissions.mayCommit).toBe(false);
    expect(m.withheld).toEqual(['the edit tool', 'the shell tool', 'the web tool']);
    expect(m.tools).toEqual(['read']);
  });
  it('makes a role key that cannot be a built-in', () => {
    expect(draftRoleKey('Penny the Scribe', 'ab12-ff')).toBe('draft-penny-the-scribe-ab12ff');
    expect(draftRoleKey('!!!', 'zz')).toBe('draft-agent-zz');
  });
  it('turns a built-in persona into a draft', () => {
    const text = builtinPersonaText('security');
    expect(text).toBeTruthy();
    const d = draftFromPersonaText(text as string);
    expect(d).toMatchObject({ name: 'Security', tools: ['read'], model: 'haiku' });
    expect(d?.instructions).toContain('Stance:');
  });
});

describe('starter gallery', () => {
  it('only lists built-ins that exist, each with a one-line outcome', () => {
    const have = new Set(builtinCapabilities().map((c) => `${c.kind}:${c.key}`));
    for (const e of STARTER_GALLERY) {
      expect(have.has(`${e.kind}:${e.key}`), `${e.kind}:${e.key}`).toBe(true);
      expect(e.outcome.length).toBeGreaterThan(20);
      expect(e.outcome.length).toBeLessThan(120);
      expect(e.outcome).not.toContain('\n');
    }
    expect(availableStarters(() => false)).toEqual([]);
    expect(availableStarters((k, key) => k === 'playbook' && key === 'prd')).toEqual([]);
  });
  it('includes the four new playbooks, each with steps', () => {
    for (const key of ['release-notes', 'pr-triage', 'weekly-status', 'incident-followup']) {
      expect(STARTER_GALLERY.some((e) => e.kind === 'playbook' && e.key === key)).toBe(true);
      const pb = builtinCapabilities().find((c) => c.kind === 'playbook' && c.key === key);
      expect(pb, key).toBeTruthy();
    }
  });
});
