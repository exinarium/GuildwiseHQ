import { describe, expect, it } from 'vitest';
import { defaultVaultName, ORG_TERMS, orgTerms, rewordForOrg } from '../src/index.ts';

const WORDS = /\b(vaults?|ledgers?|standing orders?)\b/i;

describe('ORG_TERMS', () => {
  it("keeps today's words for a dev org", () => {
    expect(ORG_TERMS.dev).toEqual({
      ledger: 'Ledger',
      theLedger: 'the ledger',
      vault: 'vault',
      Vault: 'Vault',
      vaults: 'vaults',
      Vaults: 'Vaults',
      vaultsPage: 'Vaults',
      orgVault: 'Organization vault',
      projectVault: 'Project vault',
      standingOrder: 'standing order',
      StandingOrder: 'Standing order',
      standingOrders: 'standing orders',
      StandingOrders: 'Standing orders',
      decision: 'decision',
      Decision: 'Decision',
      decisions: 'decisions',
      Decisions: 'Decisions',
    });
  });
  it('names the same things for a business org', () => {
    expect(ORG_TERMS.business).toMatchObject({
      ledger: 'Rules & decisions',
      theLedger: 'Rules & decisions',
      vault: 'knowledge folder',
      vaults: 'knowledge folders',
      vaultsPage: 'Knowledge',
      orgVault: 'Organization knowledge',
      projectVault: 'Project knowledge',
      standingOrder: 'rule',
      standingOrders: 'rules',
      StandingOrders: 'Rules',
      decisions: 'decisions',
    });
    for (const [key, word] of Object.entries(ORG_TERMS.business)) expect(word, key).not.toMatch(WORDS);
  });
  it('has the same keys in both modes', () => {
    expect(Object.keys(ORG_TERMS.business).sort()).toEqual(Object.keys(ORG_TERMS.dev).sort());
  });
});

describe('orgTerms', () => {
  it('is dev for anything but business', () => {
    expect(orgTerms('dev')).toBe(ORG_TERMS.dev);
    expect(orgTerms(undefined)).toBe(ORG_TERMS.dev);
    expect(orgTerms(null)).toBe(ORG_TERMS.dev);
    expect(orgTerms('something-new')).toBe(ORG_TERMS.dev);
    expect(orgTerms('business')).toBe(ORG_TERMS.business);
  });
});

describe('rewordForOrg', () => {
  const samples = [
    'Add to the ledger',
    'The ledger is empty',
    'Standing order (every agent loads it)',
    'Register a vault',
    'Vault conflict',
    'See /ledger and /settings/vaults',
    'Run aom ledger search "tabs"',
  ];
  it('returns the very same text in a dev org', () => {
    for (const s of samples) expect(rewordForOrg(s, 'dev')).toBe(s);
    expect(rewordForOrg(samples[0] as string, undefined)).toBe(samples[0]);
  });
  it('rewrites product prose in a business org, matching case', () => {
    const b = (s: string) => rewordForOrg(s, 'business');
    expect(b('Add to the ledger')).toBe('Add to Rules & decisions');
    expect(b('The ledger is empty')).toBe('Rules & decisions is empty');
    expect(b('Standing order (every agent loads it)')).toBe('Rule (every agent loads it)');
    expect(b('Standing orders')).toBe('Rules');
    expect(b('Register a vault')).toBe('Register a knowledge folder');
    expect(b('Your vaults')).toBe('Your knowledge folders');
    expect(b('Vault conflict')).toBe('Knowledge folder conflict');
    expect(b('Ledger conflict')).toBe('Rules & decisions conflict');
    expect(b('standing orders and decisions')).toBe('rules and decisions');
  });
  it('leaves routes, anchors, paths, ids and aom commands alone', () => {
    const keep = [
      '/ledger',
      '/settings/vaults',
      'ledger-and-vaults#ledger',
      'vault:docs/a.md',
      'vault_conflict',
      'vaultPath',
      'aom ledger search "x"',
      'a-vault-thing',
    ];
    for (const k of keep) expect(rewordForOrg(k, 'business'), k).toBe(k);
  });
  it('handles plurals and possessives', () => {
    expect(rewordForOrg("the vault's files", 'business')).toBe("the knowledge folder's files");
    expect(rewordForOrg('Ledgers differ', 'business')).toBe('Rules & decisions differ');
    expect(rewordForOrg('ledgers', 'dev')).toBe('ledgers');
  });
  it('rewrites a sentence around a guarded token only where it is prose', () => {
    expect(rewordForOrg('Use vault:<path> to write into the vault.', 'business')).toBe(
      'Use vault:<path> to write into the knowledge folder.',
    );
  });
});

describe('defaultVaultName', () => {
  it('maps the two stored default names in a business org only', () => {
    expect(defaultVaultName('Organization vault', 'business')).toBe('Organization knowledge');
    expect(defaultVaultName('Project vault', 'business')).toBe('Project knowledge');
    expect(defaultVaultName('Organization vault', 'dev')).toBe('Organization vault');
    expect(defaultVaultName('Acme vault', 'business')).toBe('Acme vault');
  });
});
