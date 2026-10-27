import {
  type IntegrationKind,
  type IntegrationKindId,
  type IntegrationScope,
  type IntegrationStatus,
  integrationCli,
  integrationScope,
  integrationsSupportedBy,
  type WorkstationIntegrationsResponse,
} from '@aom/shared';
import { BRAND } from '../brand.ts';

/** Link to a tile of the Integrations page (`focus=<kind>[:<instance>]`, `connect=1` opens the Connect dialog). */
export function integrationsLink(
  workstationId: string | null | undefined,
  focus?: string,
  opts?: { connect?: boolean },
): string {
  const base = workstationId ? `/workstations/${workstationId}/integrations` : '/integrations';
  const sp = new URLSearchParams();
  if (focus) sp.set('focus', focus);
  if (focus && opts?.connect) sp.set('connect', '1');
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/** `focus` value of a kind and instance. */
export const focusOf = (kind: string, instance: string): string => (instance ? `${kind}:${instance}` : kind);

export function parseFocus(raw: string | null): { kind: string; instance: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  return i < 0 ? { kind: raw, instance: '' } : { kind: raw.slice(0, i), instance: raw.slice(i + 1) };
}

export const tileId = (kind: string, instance: string): string => `tile-${focusOf(kind, instance)}`;

/** The registry's four display groups, in page order. */
export const GROUPS: Array<{ id: string; title: string; kinds: IntegrationKindId[] }> = [
  { id: 'ai', title: 'AI runtime', kinds: ['claude-code'] },
  { id: 'git', title: 'Git hosts', kinds: ['github', 'gitlab', 'bitbucket-cloud', 'azure-devops', 'ssh'] },
  { id: 'tracker', title: 'Trackers', kinds: ['jira'] },
  { id: 'mcp', title: 'MCP servers', kinds: ['mcp'] },
];

/** What the tiles need to know about the page: the workstation, its runner, key and policy. */
export interface PageCtx {
  workstationId: string;
  workstationName: string;
  page: WorkstationIntegrationsResponse;
}

export const runnerCanWeb = (page: WorkstationIntegrationsResponse, kind: IntegrationKind): boolean =>
  !page.legacy && integrationsSupportedBy(page.runner.integrationsVersion, kind);

/**
 * Why a change from the web is not possible right now (the tile shows the reason beside a disabled button), or null.
 * `scope` is the scope of the thing being changed: machine-wide logins are only changed from the primary pairing.
 */
export function blockReason(
  ctx: PageCtx,
  kind: IntegrationKind,
  scope: IntegrationScope,
  instance: string,
): string | null {
  const { runner } = ctx.page;
  if (!runnerCanWeb(ctx.page, kind))
    return `Update to runner >= ${instance !== '' && kind.minRunnerForInstance ? kind.minRunnerForInstance : kind.minRunner} to connect from here; until then run ${integrationCli(kind, instance)}`;
  if (!runner.connected) return `${ctx.workstationName} is offline.`;
  const p = runner.policy;
  if (p && !p.allowWeb) return 'Turned off on this workstation (guildwise-runner integrations allow-web on)';
  if (scope === 'machine' && p && (!p.primaryPairing || p.machineScopeFromWeb === 'never'))
    return 'This sign-in is shared by every pairing on this machine; connect it from the machine’s primary pairing or from a terminal.';
  return null;
}

/** The scope a tile reports: the status's own, else the kind's. */
export const scopeOf = (kind: IntegrationKind, status?: IntegrationStatus): IntegrationScope =>
  status?.scope ?? integrationScope(kind, status?.method);

/** Days from now to an ISO time, rounded up; negative when past. */
export const daysUntil = (iso: string, now = Date.now()): number =>
  Math.ceil((Date.parse(iso) - now) / 86_400_000);

/** Statuses needing the user's attention (the chooser counts the same ones server-side). */
export const needsAttention = (s: IntegrationStatus): boolean =>
  s.state === 'refused' || s.state === 'expired' || s.state === 'needs_sign_in' || s.state === 'unreachable';

const LAST_KEY = (userId: string) => `${BRAND.storagePrefix}-integrations-last-${userId}`;
export function readLastWorkstation(userId: string | undefined): string | null {
  try {
    return localStorage.getItem(LAST_KEY(userId ?? 'anon'));
  } catch {
    return null;
  }
}
export function writeLastWorkstation(userId: string | undefined, id: string): void {
  try {
    localStorage.setItem(LAST_KEY(userId ?? 'anon'), id);
  } catch {
    /* storage may be blocked; the choice is a convenience only */
  }
}
