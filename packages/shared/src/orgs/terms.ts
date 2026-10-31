import type { OrgMode } from './mode.ts';

/**
 * The words the web app uses for the ledger and the vaults. Display text only: routes, API paths, event names,
 * `aom` commands, DB columns and vault paths keep their names. Add every word a VIEW changes here, not in a component.
 */
export interface OrgTerms {
  /** Nav entry, page title, breadcrumb of /ledger. */
  ledger: string;
  /** In a sentence: "Add to the ledger" / "Add to Rules & decisions". */
  theLedger: string;
  vault: string;
  Vault: string;
  vaults: string;
  Vaults: string;
  /** Nav entry, page title and breadcrumb of /settings/vaults. */
  vaultsPage: string;
  orgVault: string;
  projectVault: string;
  standingOrder: string;
  StandingOrder: string;
  standingOrders: string;
  StandingOrders: string;
  decision: string;
  Decision: string;
  decisions: string;
  Decisions: string;
  /** The "Ask DevOps" button, dialog title and palette entry. The feature is the same in every view. */
  askDevOps: string;
  /** The same, for one item: "Ask DevOps about this". */
  askDevOpsAbout: string;
}

export const ORG_TERMS = {
  dev: {
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
    askDevOps: 'Ask DevOps',
    askDevOpsAbout: 'Ask DevOps about this',
  },
  business: {
    ledger: 'Rules & decisions',
    theLedger: 'Rules & decisions',
    vault: 'knowledge folder',
    Vault: 'Knowledge folder',
    vaults: 'knowledge folders',
    Vaults: 'Knowledge folders',
    vaultsPage: 'Knowledge',
    orgVault: 'Organization knowledge',
    projectVault: 'Project knowledge',
    standingOrder: 'rule',
    StandingOrder: 'Rule',
    standingOrders: 'rules',
    StandingOrders: 'Rules',
    decision: 'decision',
    Decision: 'Decision',
    decisions: 'decisions',
    Decisions: 'Decisions',
    askDevOps: 'Ask for technical help',
    askDevOpsAbout: 'Ask for technical help with this',
  },
} as const satisfies Record<OrgMode, OrgTerms>;

/** Anything but 'business' (missing, null, an older server) is the Software view. Pass the effective VIEW (see `effectiveView`). */
export const orgTerms = (mode: OrgMode | string | null | undefined): OrgTerms =>
  mode === 'business' ? ORG_TERMS.business : ORG_TERMS.dev;

// Longest phrase first. Built from ORG_TERMS.business so the words live in one place.
const REWRITES: Array<[string, (t: OrgTerms, upper: boolean) => string]> = [
  ['the ledger', (t) => t.theLedger],
  ['standing orders', (t, u) => (u ? t.StandingOrders : t.standingOrders)],
  ['standing order', (t, u) => (u ? t.StandingOrder : t.standingOrder)],
  ['ledgers', (t) => t.ledger],
  ['ledger', (t) => t.ledger],
  ['vaults', (t, u) => (u ? t.Vaults : t.vaults)],
  ['vault', (t, u) => (u ? t.Vault : t.vault)],
];
const REWRITE_RE = new RegExp(
  `(?<![\\w/#.:@-])(${REWRITES.map(([k]) => k).join('|')})(?![\\w/_-]|:\\S)`,
  'gi',
);

/**
 * Rewrites product copy for a view. Dev returns the same string. Business replaces whole words and keeps
 * routes, anchors, `vault:` paths, ids and `aom ledger ...` commands. Never pass user or agent content through it.
 */
export function rewordForOrg(text: string, mode: OrgMode | string | null | undefined): string {
  if (mode !== 'business' || !text) return text;
  const t = ORG_TERMS.business;
  return text.replace(REWRITE_RE, (match, _w, offset: number, whole: string) => {
    if (whole.slice(Math.max(0, offset - 4), offset) === 'aom ') return match;
    const hit = REWRITES.find(([k]) => k === match.toLowerCase());
    if (!hit) return match;
    return hit[1](t, match[0] !== match[0]!.toLowerCase());
  });
}

/** The two names the server gives new vaults; any other (user chosen) name is shown as it is. */
export function defaultVaultName(name: string, mode: OrgMode | string | null | undefined): string {
  const t = orgTerms(mode);
  if (name === ORG_TERMS.dev.orgVault) return t.orgVault;
  if (name === ORG_TERMS.dev.projectVault) return t.projectVault;
  return name;
}
