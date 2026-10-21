import {
  type ConnectionState,
  type DeliverySetup,
  type SetupEnv,
  type SetupStateDto,
  type SetupTargetDto,
  type UpdateMethod,
  updateMethodOf,
} from '@aom/shared';
import type { EnvStatusDto } from '../../api/queries/environments.ts';
import { describeGate } from '../delivery/gate-text.ts';

/**
 * The pure part of the Environments page (docs/design/environments-ux.md sections 1, 3 and 6): the role of an environment,
 * the Places derived from the deploy targets, the state of a card (one chip, one sentence, one next action) and the plain
 * words for the update rule and the update method. No React.
 */

export type EnvRole = 'test' | 'live' | 'other';
export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'neutral';

export const ROLE_TITLE: Record<EnvRole, string> = {
  test: 'Test site',
  live: 'Live site',
  other: 'Extra site',
};

/** `role` is stored on the environment by a newer server; without it the role is read from what the setup says. */
export function roleOf(env: SetupEnv, target?: { production?: boolean } | undefined): EnvRole {
  const stored = (env as { role?: string }).role;
  if (stored === 'test' || stored === 'live' || stored === 'other') return stored;
  if (target?.production || env.name === 'production') return 'live';
  if (typeof env.gate === 'object' && env.gate.requires.some((r) => 'envHealthy' in r)) return 'live';
  if (env.trigger[0] === 'after_merge' || /^(uat|test|staging)/.test(env.name)) return 'test';
  return 'other';
}

/** The old wizard called the first environment "Test copy"; a Test copy is now the temporary copy of one card. */
export function displayLabel(env: Pick<SetupEnv, 'label'>, role: EnvRole): string {
  return role === 'test' && /^test copy$/i.test(env.label.trim()) ? 'Test site' : env.label;
}

/** A name for a new environment: lowercase letters, digits and dashes, not used yet. */
export function slugName(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'site';
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

// ------------------------------------------------------------------------------------------------ places

export interface PlaceVm {
  /** The deploy target behind it. */
  id: string;
  /** The target's own name (stable key for tests and links). */
  key: string;
  kind: 'computer' | 'server';
  name: string;
  /** "this computer", "server 192.168.1.13". */
  what: string;
  host: string | null;
  appUrl: string | null;
  workstationId: string | null;
  workstationName: string | null;
  /** Computer: is the Guildwise computer online. */
  online: boolean | null;
  /** Server: can the deploying computer sign in. */
  reach: { state: ConnectionState; at: string; detail: string | null } | null;
  production: boolean;
  role: 'active' | 'standby' | 'retired';
  usedBy: Array<{ name: string; label: string }>;
  /** The place (id) this one repeats: same server address, or same computer. */
  duplicateOf: string | null;
  duplicateName: string | null;
  keys: SetupTargetDto['keys'];
}

type EnvLite = Pick<SetupEnv, 'name' | 'label' | 'target'>;

/** The environments shown on the page: what `delivery/` holds, then the ones only the unfinished draft has. */
export function allEnvironments(s: SetupStateDto): Array<{ env: SetupEnv; draft: boolean }> {
  const current = s.current.setup?.environments ?? [];
  const draftSetup = s.draft?.setup as DeliverySetup | null | undefined;
  const draftOnly = (draftSetup?.environments ?? []).filter((d) => !current.some((c) => c.name === d.name));
  return [
    ...current.map((env) => ({ env, draft: false })),
    ...draftOnly.map((env) => ({ env, draft: true })),
  ];
}

export function placesOf(
  s: SetupStateDto,
  envs: EnvLite[] = allEnvironments(s).map((e) => e.env),
): PlaceVm[] {
  const out: PlaceVm[] = [];
  for (const t of s.targets) {
    const kind = t.kind === 'remote_ssh' ? 'server' : 'computer';
    const sameAs = out.find(
      (o) =>
        o.role === 'active' &&
        o.kind === kind &&
        (kind === 'server'
          ? !!t.host && o.host === t.host
          : (o.workstationId ?? null) === (t.workstationId ?? null)),
    );
    out.push({
      id: t.id,
      key: t.name,
      kind,
      name: kind === 'computer' ? (t.workstationName ?? 'Any computer of the project') : t.name,
      what: kind === 'computer' ? 'this computer' : `server ${t.host ?? ''}`.trim(),
      host: t.host,
      appUrl: t.appUrl,
      workstationId: t.workstationId,
      workstationName: t.workstationName,
      online: t.workstationOnline,
      reach: t.connection
        ? { state: t.connection.state, at: t.connection.at, detail: t.connection.detail }
        : null,
      production: t.production,
      role: t.role ?? 'active',
      usedBy: envs
        .filter((e) => e.target.toLowerCase() === t.name.toLowerCase())
        .map((e) => ({ name: e.name, label: e.label })),
      duplicateOf: (t.role ?? 'active') === 'active' && sameAs ? sameAs.id : null,
      duplicateName: sameAs?.name ?? null,
      keys: t.keys,
    });
  }
  return out;
}

export const placeOfEnv = (places: PlaceVm[], env: Pick<SetupEnv, 'target'>): PlaceVm | undefined =>
  places.find((p) => p.key.toLowerCase() === env.target.toLowerCase());

/** Why nothing can be done with a place right now, in a sentence; null when it is fine. */
export function placeProblem(
  p: PlaceVm | undefined,
): { text: string; fix: 'check' | 'reconnect' | null } | null {
  if (!p) return null;
  if (p.kind === 'computer')
    return p.online === false ? { text: `${p.name} is offline`, fix: 'check' } : null;
  const s = p.reach?.state;
  if (!s || s === 'reachable' || s === 'unchecked') return null;
  if (s === 'host_key_changed') return { text: `The identity of ${p.name} changed`, fix: 'reconnect' };
  if (s === 'unreachable') return { text: `Cannot reach ${p.name}`, fix: 'check' };
  return { text: `Cannot sign in to ${p.name}`, fix: 'reconnect' };
}

// ------------------------------------------------------------------------------------------------ the state of a card

export type CardState =
  | 'draft'
  | 'needs_try'
  | 'waiting_approval'
  | 'changed'
  | 'healthy'
  | 'updating'
  | 'blocked'
  | 'cannot_reach'
  | 'failed'
  | 'custom'
  | 'not_set_up';

export type CardAction =
  | 'review'
  | 'try'
  | 'approve'
  | 'update'
  | 'release'
  | 'check'
  | 'reconnect'
  | 'fix'
  | 'retry'
  | 'back_to_guided'
  | null;

export interface Strip {
  saved: boolean;
  tried: boolean;
  approved: boolean;
}

export interface CardInfo {
  state: CardState;
  chip: { label: string; tone: Tone };
  sentence: string;
  action: CardAction;
  strip: Strip;
  role: EnvRole;
  label: string;
}

export function stripOf(s: SetupStateDto, env: SetupEnv, draft: boolean): Strip {
  const saved = !draft && s.current.recipePresent;
  const missing = s.current.dryRunMissing;
  const tried = saved && (missing ? !missing.includes(env.name) : s.current.dryRunOk.includes(env.name));
  return { saved, tried, approved: saved && s.current.recipeStatus === 'approved' };
}

const when = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return '';
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

export { when as agoText };

export function cardInfo(args: {
  s: SetupStateDto;
  env: SetupEnv;
  draft: boolean;
  place: PlaceVm | undefined;
  status: EnvStatusDto | undefined;
  now?: number;
}): CardInfo {
  const { s, env, draft, place, status, now } = args;
  const role = roleOf(env, place);
  const label = displayLabel(env, role);
  const strip = stripOf(s, env, draft);
  const base = { strip, role, label };
  const problem = placeProblem(place);
  const version = status?.version ?? null;
  const last = status?.lastRun ?? null;

  if (env.mode === 'custom' || s.current.handEdited.includes(env.name))
    return {
      ...base,
      state: 'custom',
      chip: { label: 'Custom', tone: 'amber' },
      sentence: 'Edited by hand: shown as a script.',
      action: 'back_to_guided',
    };
  if (draft)
    return {
      ...base,
      state: 'draft',
      chip: { label: 'Draft', tone: 'neutral' },
      sentence: 'Not saved. Nothing has changed yet.',
      action: 'review',
    };
  if (status?.health === 'updating' || last?.status === 'running' || last?.status === 'queued')
    return {
      ...base,
      state: 'updating',
      chip: { label: 'Updating', tone: 'blue' },
      sentence: status?.updatingStep ? `Updating: ${status.updatingStep}.` : 'Updating now.',
      action: null,
    };
  if (last && (last.status === 'failed' || last.status === 'refused') && strip.approved)
    return {
      ...base,
      state: 'failed',
      chip: { label: 'Failed', tone: 'red' },
      sentence: failureSentence(last),
      action: 'fix',
    };
  if (problem)
    return {
      ...base,
      state: 'cannot_reach',
      chip: { label: 'Cannot reach', tone: 'red' },
      sentence: `${problem.text}. Updates are blocked until it is back.`,
      action: problem.fix === 'reconnect' ? 'reconnect' : 'check',
    };
  if (!strip.tried)
    return {
      ...base,
      state: 'needs_try',
      chip: { label: 'Needs a try', tone: 'amber' },
      sentence: 'Saved. Try it before the Owner approves.',
      action: 'try',
    };
  if (!strip.approved) {
    const changed = s.current.recipeStatus === 'changed_unapproved';
    return {
      ...base,
      state: changed ? 'changed' : 'waiting_approval',
      chip: changed ? { label: 'Changed', tone: 'amber' } : { label: 'Waiting for approval', tone: 'amber' },
      sentence: changed
        ? 'The setup changed since the last approval. Review it and approve, or go back.'
        : 'Tried: would work. Waiting for the Owner to approve.',
      action: 'approve',
    };
  }
  const waiting = status?.waitingRelease;
  if (role === 'live' && waiting && !waiting.rulesMet)
    return {
      ...base,
      state: 'blocked',
      chip: { label: 'Blocked', tone: 'amber' },
      sentence: `Waiting for: ${waiting.waitingFor.join('; ') || 'the rules'}.`,
      action: null,
    };
  const since = status?.since ? `, since ${when(status.since, now)}` : '';
  return {
    ...base,
    state: 'healthy',
    chip:
      status?.health === 'unhealthy'
        ? { label: 'Not answering', tone: 'red' }
        : status?.health === 'unknown' || !status
          ? { label: 'Ready', tone: 'green' }
          : { label: 'Healthy', tone: 'green' },
    sentence: version ? `Version ${version} is live${since}.` : 'Nothing has been updated here yet.',
    action: role === 'live' ? (waiting ? 'release' : null) : 'update',
  };
}

function failureSentence(last: NonNullable<EnvStatusDto['lastRun']>): string {
  const step = last.failedStep ? `The update stopped at ${last.failedStep}` : 'The last update did not work';
  const why = last.reason ?? last.summary;
  const back = last.wentBackTo ? ` Went back to ${last.wentBackTo}.` : '';
  return `${step}${why ? `: ${why}` : '.'}${why && !/[.!?]$/.test(why) ? '.' : ''}${back}`;
}

// ------------------------------------------------------------------------------------------------ words

export function updateRuleText(env: SetupEnv): string {
  return env.trigger[0] === 'after_merge' ? 'after each merge' : 'when you release';
}

export const METHOD_TEXT: Record<UpdateMethod, { title: string; text: string; short: string }> = {
  registry: {
    title: 'Download a ready-made app from a registry',
    text: 'The server downloads the new version from your image registry. Best when you already publish images.',
    short: 'download from a registry',
  },
  build_on_server: {
    title: 'Build it on the server',
    text: 'The server builds the app from the approved code. It needs build tools on the server and takes longer.',
    short: 'built on the server',
  },
  ship: {
    title: 'Build here and copy it',
    text: 'Guildwise builds the app on your computer and sends it to the server.',
    short: 'copied from your computer',
  },
};

export const updateMethod = (env: SetupEnv): UpdateMethod => updateMethodOf(env);

/** "Updates the existing app by copying it from your computer" / "Starts with your start steps". */
export function howItStarts(env: SetupEnv, hasPlan: boolean): string {
  if (env.hosting === 'ssh') return `Updates the existing app: ${METHOD_TEXT[updateMethodOf(env)].short}.`;
  if (env.app.composeFile) return `Updates the app that is already running (${env.app.service}).`;
  return hasPlan ? 'Starts with your start steps.' : 'Starts a new copy.';
}

/** The rules of an environment, one sentence each, in plain words. */
export function rulesOf(env: SetupEnv, labelOf: (name: string) => string): string[] {
  const out: string[] = [];
  if (typeof env.gate === 'object') out.push(...describeGate(env.gate, labelOf));
  else if (env.gate !== 'none') out.push(`Follows the shared rule "${env.gate}"`);
  if (env.releasedBy === 'owner' && env.trigger[0] !== 'after_merge') out.push('You approve every release');
  return out;
}

/** The host of an address, for a short line ("hq.example.com"). */
export const hostOf = (url: string | null | undefined): string => {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
