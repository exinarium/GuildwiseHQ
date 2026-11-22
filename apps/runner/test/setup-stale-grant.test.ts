import { randomUUID } from 'node:crypto';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../src/policy/schema.ts';
import { applyChoices, initialChoices, replacedGrants } from '../src/setup/choices.ts';
import { readAllOffers, SETUP_OFFERS_FILE, writeOffers } from '../src/setup/offers.ts';
import { parseSetupOptions } from '../src/setup/options.ts';
import { renderScreen } from '../src/setup/screen.ts';
import { readWindowOffers } from '../src/window/api.ts';

/**
 * UAT 1.10.0 finding 2: after a reinstall that paired a new workstation (or after a new DevOps hire) the local grant kept
 * the old agent id and the installer's screen did not update it. The screen now maps the organisation's helper to the
 * CURRENT agent id from the server's offers and replaces the stale grant (logged); a re-run that changes nothing keeps it.
 */
const ORG = randomUUID();
const OLD = randomUUID();
const NEW = randomUUID();
const offers = [
  { orgId: ORG, orgName: 'Acme Law', role: 'Owner', devopsAgentId: NEW, devopsAgentName: 'Forge' },
];
const policy = (agents: Record<string, string>): Policy => {
  const p = structuredClone(DEFAULT_POLICY);
  p.devops.agents = agents;
  p.setupDone = true;
  return p;
};
const choices = (current: Policy, raw = {}) =>
  initialChoices({ current, orgs: offers, repos: [], opts: parseSetupOptions(raw, {}), platform: 'linux' });

describe('a stale DevOps grant on a re-run of setup', () => {
  it('is replaced by the current helper, shown on the screen and reported', () => {
    const c = choices(policy({ [ORG]: OLD }));
    expect(c.orgs[0]).toMatchObject({ allow: true, agentId: NEW, agentName: 'Forge', replaces: OLD });
    expect(renderScreen(c).join('\n')).toMatch(
      /Acme Law \(you are Owner\), helper "Forge" \(replaces an old helper\)/,
    );
    expect(replacedGrants(c)).toEqual([
      { orgId: ORG, orgName: 'Acme Law', from: OLD, to: NEW, agentName: 'Forge' },
    ]);
    const next = policy({ [ORG]: OLD });
    applyChoices(c, next);
    expect(next.devops.agents).toEqual({ [ORG]: NEW });
  });

  it('also under --yes and with --devops-orgs by name', () => {
    for (const raw of [{ yes: true }, { devopsOrgs: 'Acme Law' }]) {
      const next = policy({ [ORG]: OLD });
      applyChoices(choices(policy({ [ORG]: OLD }), raw), next);
      expect(next.devops.agents).toEqual({ [ORG]: NEW });
    }
  });

  it('a re-run that changes nothing keeps the grant (nothing replaced)', () => {
    const c = choices(policy({ [ORG]: NEW }));
    expect(c.orgs[0]?.replaces).toBeUndefined();
    expect(replacedGrants(c)).toEqual([]);
    const next = policy({ [ORG]: NEW });
    applyChoices(c, next);
    expect(next.devops.agents).toEqual({ [ORG]: NEW });
  });

  it('a declined organisation is not granted the new helper either', () => {
    const c = choices(policy({}));
    const next = policy({});
    applyChoices(c, next);
    expect(next.devops.agents).toEqual({});
  });

  it('with two pairings the freshest offers win (the old pairing still names the old engineer)', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'aom-old-'));
    const newDir = mkdtempSync(join(tmpdir(), 'aom-new-'));
    writeOffers(oldDir, { orgs: [{ ...offers[0], devopsAgentId: OLD } as never], repos: [] });
    writeOffers(newDir, { orgs: offers as never, repos: [] });
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(oldDir, SETUP_OFFERS_FILE), past, past);
    // the old pairing is listed first (it was paired first)
    expect(readAllOffers([oldDir, newDir]).orgs[0]?.devopsAgentId).toBe(NEW);
    expect(readWindowOffers([oldDir, newDir]).orgs[0]?.devopsAgentId).toBe(NEW);
  });
});

describe('item 7: DevOps helpers may install tools (UAT 1.10.0 finding 3)', () => {
  it('safe default No, explained on the screen, and not written unless chosen (a re-run never turns the website switch off)', () => {
    const c = choices(policy({}));
    expect(c.devopsInstall).toBe(false);
    expect(renderScreen(c).join('\n')).toMatch(
      // REVIEW S4: not chosen here, so the website's switch decides; the screen says so instead of a "No"
      / 7 {2}DevOps helpers may install the tools projects need \(runner's own folder\) \.+ As set on the website/,
    );
    const next = policy({});
    applyChoices(c, next);
    expect(next.devopsInstall).toBeUndefined();
  });

  it('a Yes is written, and a re-run starts from it', async () => {
    const { applyEdit } = await import('../src/setup/choices.ts');
    const c = applyEdit(choices(policy({})), '7', true);
    const next = policy({});
    applyChoices(c, next);
    expect(next.devopsInstall).toBe(true);
    expect(choices(next).devopsInstall).toBe(true);
    expect(renderScreen(choices(next)).join('\n')).toMatch(/ 7 .*\.+ Yes/);
    const no = policy({});
    applyChoices(applyEdit(choices(policy({})), '7', false), no);
    expect(renderScreen(choices(no)).join('\n')).toMatch(/ 7 .*\.+ No$/m);
  });
});
