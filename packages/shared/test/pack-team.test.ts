import { describe, expect, it } from 'vitest';
import {
  AgentDtoSchema,
  DomainEventSchema,
  handlesNote,
  humaniseKey,
  indexPack,
  PACK_SEAT_KEYS,
  PackSnapshotSchema,
  packAgentBriefOf,
  packAgentCommandRef,
  packAgentSection,
  packSnapshotOf,
  renderChatInstructions,
  suggestSeat,
} from '../src/index.ts';
import { smallMarketplace } from './fixtures/plugin-marketplace-fixture.ts';
import { thirdPartyLayoutStable } from './fixtures/third-party-layout-fixture.ts';

describe('suggested seats', () => {
  const cases: Array<[string, string, string | undefined, string]> = [
    ['bmad-agent-analyst', 'Mary', undefined, 'analyst'],
    ['bmad-agent-pm', 'John', undefined, 'planner'],
    ['bmad-agent-dev', 'Amelia', undefined, 'builder'],
    ['bmad-agent-architect', 'Winston', undefined, 'architect'],
    ['bmad-agent-tech-writer', 'Paige', undefined, 'writer'],
    ['bmad-agent-qa', 'Quinn', undefined, 'tester'],
    ['bmad-agent-sm', 'Bob', 'Scrum Master', 'ba'],
    ['po', 'Product Owner', undefined, 'ba'],
    ['backend-architect', 'Backend Architect', 'Designs services', 'architect'],
    ['code-reviewer', 'Code Reviewer', undefined, 'reviewer'],
    ['test-engineer', 'Test Engineer', undefined, 'tester'],
    ['frontend-developer', 'Frontend Developer', undefined, 'builder'],
    ['market-researcher', 'Researcher', undefined, 'researcher'],
    ['bmad-agent-ux-designer', 'Sally', 'Designs user experience', 'own'],
    ['x', 'Poet', 'Writes verses of poetry', 'own'],
  ];
  for (const [key, name, description, seat] of cases)
    it(`${key} -> ${seat}`, () => {
      expect(suggestSeat({ key, name, ...(description ? { description } : {}) })).toBe(seat);
    });
  it('uses the description only when the name says nothing, and never suggests ceo or devops', () => {
    expect(suggestSeat({ key: 'helper', name: 'Helper', description: 'Reviews pull requests' })).toBe(
      'reviewer',
    );
    expect(suggestSeat({ key: 'dev-ops', name: 'Ops', description: 'engineer' })).toBe('builder');
    expect(PACK_SEAT_KEYS).not.toContain('ceo');
    expect(PACK_SEAT_KEYS).not.toContain('devops');
  });
  it('humanises a key', () => expect(humaniseKey('bmad-agent-analyst')).toBe('Bmad Agent Analyst'));
});

describe('agent information read from a pack', () => {
  const r = indexPack({ name: 'bmad', adapter: 'auto', tree: thirdPartyLayoutStable() });
  const item = (k: string) => r.entries.find((e) => e.key === `bmad:${k}`);
  it("takes a skill's agent name from an [agent] table and the skills it names as references", () => {
    expect(item('bmad-agent-analyst')?.displayName).toBe('Mary');
    expect(item('bmad-agent-pm')?.displayName).toBe('John');
    expect(item('bmad-agent-analyst')?.skillRefs).toContain('bmad-brainstorming');
    // a skill that is not an agent has no name of its own
    expect(item('bmad-brainstorming')?.displayName).toBeUndefined();
    // never itself
    expect(item('bmad-agent-analyst')?.skillRefs).not.toContain('bmad-agent-analyst');
  });
  it('travels in the snapshot (metadata only) and does not change a hash', () => {
    const snap = packSnapshotOf({ name: 'bmad', ref: 'main', sha: 'a'.repeat(40), index: r });
    expect(PackSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.items.find((i) => i.key === 'bmad:bmad-agent-analyst')?.displayName).toBe('Mary');
    const again = indexPack({ name: 'bmad', adapter: 'auto', tree: thirdPartyLayoutStable() });
    expect(again.entries.map((e) => e.hash)).toEqual(r.entries.map((e) => e.hash));
  });
  it('lists the skills of a subagent file', () => {
    const t = {
      ...smallMarketplace(),
      'plugins/backend/skills/api-design/SKILL.md': '---\nname: api-design\ndescription: d\n---\nx\n',
      'plugins/backend/agents/backend-architect.md':
        '---\nname: backend-architect\ndescription: Designs.\nskills:\n  - api-design\n---\nYou design. Use api-design.\n',
    };
    const p = indexPack({ name: 'market', tree: t });
    const a = p.entries.find((e) => e.key === 'market:backend-architect');
    expect(a?.kind).toBe('persona');
    // a bare word is never a reference, but the persona's own `skills:` list is
    expect(a?.skillRefs).toEqual(['api-design']);
  });
});

describe('the pack agent block and the handles line', () => {
  const pa = packAgentBriefOf({
    packId: '0194d2c0-0000-7000-8000-000000000001',
    packName: 'bmad',
    key: 'bmad-agent-analyst',
    kind: 'skill',
    name: 'Mary',
    sha: 'a'.repeat(40),
    ref: null,
  });
  it('is fenced and says the role wins', () => {
    const [h, block] = packAgentSection({ packAgent: pa });
    expect(h).toBe('# Your agent from a pack');
    expect(block).toContain('UNTRUSTED CONTENT');
    expect(block).toContain('You work as Mary from bmad.');
    expect(block).toContain('`aom skill show bmad:bmad-agent-analyst`');
    expect(block).toContain("Your role's rules, gates and permissions win");
    expect(packAgentSection({})).toEqual([]);
  });
  it('a persona is loaded with its kind prefix', () => {
    expect(packAgentCommandRef({ kind: 'persona', packName: 'p', key: 'x' })).toBe('persona:p:x');
  });
  it('changes the handles line for pack agents only', () => {
    expect(handlesNote({}, 'do not roleplay.')).toBe('Names are handles, not personas: do not roleplay.');
    expect(handlesNote({ packAgent: pa }, 'do not roleplay.')).toContain('an agent from a pack');
    const plain = renderChatInstructions({ name: 'Ann', roleKey: 'builder', seniority: 'senior' }, {});
    expect(plain).toContain('Names are handles, not personas');
    expect(plain).not.toContain('Your agent from a pack');
    const withPack = renderChatInstructions(
      { name: 'Mary', roleKey: 'analyst', seniority: 'senior', packAgent: pa },
      {},
    );
    expect(withPack).toContain('# Your agent from a pack');
    expect(withPack).toContain('You work as Mary from bmad.');
  });
});

describe('new optional fields stay replay-safe', () => {
  it('an AgentHired without packPersona still parses, and one with it round-trips', () => {
    const base = {
      agentId: '0194d2c0-0000-7000-8000-000000000002',
      orgId: '0194d2c0-0000-7000-8000-000000000003',
      hiredByUserId: '0194d2c0-0000-7000-8000-000000000004',
      workstationId: '0194d2c0-0000-7000-8000-000000000005',
      name: 'Mary',
      roleKey: 'analyst',
      roleVersion: 1,
      seniority: 'senior',
      runtime: 'claude-code',
      model: 'sonnet',
      skills: [],
      permissions: {
        allowedTools: [],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: false,
        riskTiers: ['small', 'large'],
        repoIds: null,
      },
      capacity: 1,
      isDevops: false,
    };
    expect(DomainEventSchema.safeParse({ type: 'AgentHired', payload: base }).success).toBe(true);
    const withPack = {
      ...base,
      packPersona: {
        packId: '0194d2c0-0000-7000-8000-000000000001',
        packName: 'bmad',
        key: 'bmad-agent-analyst',
        kind: 'skill',
        name: 'Mary',
        sha: 'a'.repeat(40),
      },
    };
    const r = DomainEventSchema.safeParse({ type: 'AgentHired', payload: withPack });
    expect(r.success).toBe(true);
    void AgentDtoSchema;
  });
});
