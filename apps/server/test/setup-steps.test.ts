import { describe, expect, it } from 'vitest';
import { buildSetupSteps, type SetupFacts, summarize } from '../src/queries/setup-checklist.ts';

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  business: false,
  manager: true,
  intakeOn: true,
  project: null,
  withRepo: false,
  workstation: false,
  missing: ['ba', 'builder', 'reviewer', 'tester'],
  talked: false,
  knowledge: false,
  rules: false,
  connections: false,
  ...over,
});
const biz = (over: Partial<SetupFacts> = {}) => facts({ business: true, missing: ['ba'], ...over });
const ids = (f: SetupFacts) => buildSetupSteps(f).map((s) => s.id);
const step = (f: SetupFacts, id: string) => buildSetupSteps(f).find((s) => s.id === id);

describe('buildSetupSteps', () => {
  it('a dev org gets exactly the five steps it always had', () => {
    expect(ids(facts())).toEqual(['project', 'repository', 'workstation', 'team', 'ba']);
    expect(buildSetupSteps(facts({ project: { id: 'p1' } }))).toMatchInlineSnapshot(`
      [
        {
          "actionable": true,
          "done": true,
          "hint": "A project holds a board of cards, its repositories and its team.",
          "id": "project",
          "link": null,
          "title": "Create your first project",
        },
        {
          "actionable": true,
          "done": false,
          "hint": "Tell Guildwise HQ where the code lives: GitHub, GitLab, Bitbucket, Azure DevOps or any git server.",
          "id": "repository",
          "link": "/projects/p1/settings#repos",
          "title": "Add its repository",
        },
        {
          "actionable": true,
          "done": false,
          "hint": "The machine that runs your agents: your own computer, a VPS or a GitHub Codespace. A DevOps engineer for it is hired automatically.",
          "id": "workstation",
          "link": "/workstations?add=1",
          "title": "Add a workstation",
        },
        {
          "actionable": true,
          "done": false,
          "hint": "A business analyst, a builder, a reviewer and a tester.",
          "id": "team",
          "link": "/agents?hire=ba",
          "missing": [
            "business analyst",
            "builder",
            "reviewer",
            "tester",
          ],
          "title": "Hire your team",
        },
        {
          "actionable": true,
          "done": false,
          "hint": "Describe something you need, in a chat or an intake; the analyst turns it into cards.",
          "id": "ba",
          "link": "/intake",
          "title": "Talk to the business analyst",
        },
      ]
    `);
    expect(summarize(buildSetupSteps(facts()))).toMatchObject({ doneCount: 0, complete: false });
  });

  it('a business org with nothing done has seven steps and no repository step', () => {
    const steps = buildSetupSteps(biz());
    expect(steps.map((s) => s.id)).toEqual([
      'project',
      'workstation',
      'team',
      'knowledge',
      'rules',
      'ba',
      'connections',
    ]);
    expect(summarize(steps)).toMatchObject({ doneCount: 0, complete: false });
    expect(steps.filter((s) => s.optional).map((s) => s.id)).toEqual(['connections']);
    expect(step(biz(), 'knowledge')?.link).toBe('/documents');
    expect(step(biz(), 'rules')?.link).toBe('/ledger');
    expect(step(biz(), 'connections')?.link).toBe('/automations');
    expect(step(biz(), 'team')).toMatchObject({ link: '/agents?hire=ba', missing: ['business analyst'] });
  });

  it('knowledge, rules and connections each flip on their own', () => {
    for (const k of ['knowledge', 'rules', 'connections'] as const) {
      const steps = buildSetupSteps(biz({ [k]: true }));
      expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual([k]);
      expect(steps.find((s) => s.id === k)?.link).toBeNull();
    }
  });

  it('completes without a repository, and the optional connections step never counts', () => {
    const done = biz({
      project: { id: 'p' },
      workstation: true,
      missing: [],
      knowledge: true,
      rules: true,
      talked: true,
    });
    expect(summarize(buildSetupSteps(done))).toMatchObject({ doneCount: 6, complete: true });
    expect(summarize(buildSetupSteps({ ...done, rules: false }))).toMatchObject({
      doneCount: 5,
      complete: false,
    });
    expect(summarize(buildSetupSteps({ ...done, connections: true }))).toMatchObject({
      doneCount: 6,
      complete: true,
    });
  });

  it('members see the new steps read-only, without a link', () => {
    const s = buildSetupSteps(biz({ manager: false }));
    for (const id of ['knowledge', 'rules', 'connections'])
      expect(s.find((x) => x.id === id)).toMatchObject({ actionable: false, link: null });
  });

  it('business text says Knowledge and Rules & decisions, never Vault, Ledger, repository or DevOps', () => {
    const text = buildSetupSteps(biz())
      .map((s) => `${s.title} ${s.hint}`)
      .join('\n');
    expect(text).not.toMatch(/vault|ledger|repositor|devops/i);
    expect(text).toContain('Knowledge');
    expect(text).toContain('Rules & decisions');
  });
});
