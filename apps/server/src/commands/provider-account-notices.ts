import {
  accountScopeDef,
  isKeyScope,
  isLoginScope,
  keyAccountUsable,
  MAIN_ACCOUNT,
  ORG_ACCOUNT,
  PROVIDER_ACCOUNTS_CAPABILITY,
  type ProviderKeyId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { agentOrgs, type Notice, reconcile, sendMails, type WsRef } from './workstation-notices.ts';

/**
 * Desk notices about the accounts of Codex, the Gemini CLI and the provider keys (S-A), generalised from the Claude ones
 * (`claude-account-notices.ts`, docs/design/claude-accounts.md section 2.5): per (workstation, account), raised once for the
 * workstation's owner, closed when the account works again.
 *
 *  - `provider_account_login`: an account a project names has no working login (Codex, Gemini CLI) or no key (a provider), or the
 *    runner is too old to have accounts. The main account of a login runtime counts when the workstation has agents on it.
 *  - `provider_account_usage` (information): a login account reached its usage limit; its projects fall back or wait.
 */

export const PROVIDER_ACCOUNT_LOGIN_SUBKIND = 'provider_account_login';
export const PROVIDER_ACCOUNT_USAGE_SUBKIND = 'provider_account_usage';

interface AccountEntry {
  key: string;
  main?: boolean;
  login?: string;
  usage?: string;
  limitedUntil?: string;
  limitedLabel?: string;
  configDir?: string;
}
interface Report {
  id: string;
  auth?: string | undefined;
  usage?: string | undefined;
  limitedUntil?: string | undefined;
  limitedLabel?: string | undefined;
  accounts?: AccountEntry[] | undefined;
  keys?: unknown;
}

interface Ref {
  orgId: string;
  scope: string;
  account: string;
  projects: Array<{ key: string; fallback: boolean }>;
}

/** What the projects of the workstation's organizations name, per organization, scope and account. */
async function projectRefs(tx: Tx, orgIds: string[]): Promise<Ref[]> {
  const list = await rows<{
    org_id: string;
    scope: string;
    account: string;
    pkey: string;
    fallback: boolean;
  }>(
    tx,
    `SELECT p.org_id, pa.scope, pa.account_key AS account, p.key AS pkey, pa.fallback_to_main AS fallback
       FROM project_provider_accounts pa JOIN projects p ON p.id = pa.project_id
      WHERE p.status = 'active' AND p.org_id = ANY($1::uuid[])
      ORDER BY p.key`,
    [orgIds],
  );
  const out = new Map<string, Ref>();
  for (const r of list) {
    const k = `${r.org_id}|${r.scope}|${r.account}`;
    const e = out.get(k) ?? { orgId: r.org_id, scope: r.scope, account: r.account, projects: [] };
    e.projects.push({ key: r.pkey, fallback: r.fallback });
    out.set(k, e);
  }
  return [...out.values()];
}

const effectOf = (projects: Array<{ key: string; fallback: boolean }>): string => {
  const fb = projects.filter((p) => p.fallback).map((p) => p.key);
  const paused = projects.filter((p) => !p.fallback).map((p) => p.key);
  return [
    fb.length > 0 ? `Projects ${fb.join(', ')} run on the main account meanwhile.` : '',
    paused.length > 0 ? `Projects ${paused.join(', ')} are paused (not failed) until it works.` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

export type ProviderAccountProblem = 'expired' | 'none' | 'missing' | 'no_key' | 'old_runner';

/** The sign-in or key notice for an account: what is wrong and how to fix it, browser first. */
export function providerAccountLoginText(
  workstation: string,
  scope: string,
  account: string,
  problem: ProviderAccountProblem,
  projects: Array<{ key: string; fallback: boolean }>,
): { title: string; body: string } {
  const label = accountScopeDef(scope)?.label ?? scope;
  const who =
    account === MAIN_ACCOUNT
      ? 'main account'
      : account === ORG_ACCOUNT
        ? 'organization key'
        : `account ${account}`;
  const effect = projects.length > 0 ? ` ${effectOf(projects)}` : '';
  const where = `Integrations page of ${workstation}, AI runtime`;
  if (problem === 'old_runner')
    return {
      title: `Update the runner on ${workstation} to use ${label} ${who}`,
      body: `Projects name the ${label} ${who}, but the runner on ${workstation} is too old to have accounts for it: update the runner to 0.1.58 or later.${effect}`,
    };
  if (problem === 'missing' && isLoginScope(scope))
    return {
      title: `${label} ${who} is not set up on ${workstation}`,
      body: `Projects name the ${label} ${who}, but ${workstation} has no such account yet. Open the ${where}, add the account and sign in: that creates its folder on the workstation.${effect}`,
    };
  if (problem === 'no_key' || problem === 'missing') {
    const org = account === ORG_ACCOUNT;
    return {
      title: `${label} ${who} has no key on ${workstation}`,
      body: org
        ? `Projects use the organization's ${label} key, but ${workstation} does not hold it (or the organization has none). An Owner or Admin can share it under Settings, Model providers.${effect}`
        : `The ${label} ${who} has no key on ${workstation}. Add it on the ${where} ("Set key").${effect}`,
    };
  }
  const what = problem === 'expired' ? 'login has expired' : 'has not been signed in yet';
  return {
    title: `${label} ${who} needs a sign-in on ${workstation}`,
    body: `The ${label} ${who} on ${workstation} ${what}. Sign in from the browser: open the ${where}, choose Sign in for it, open the link and follow the steps.${effect}`,
  };
}

export const providerAccountUsageText = (
  workstation: string,
  scope: string,
  account: string,
  resumes: string,
  projects: Array<{ key: string; fallback: boolean }>,
): { title: string; body: string } => {
  const label = accountScopeDef(scope)?.label ?? scope;
  const who = account === MAIN_ACCOUNT ? 'main account' : `account ${account}`;
  return {
    title: `${label} ${who} reached its usage limit on ${workstation}`,
    body: `The ${label} ${who} on ${workstation} reached its usage limit until ${resumes}. ${effectOf(projects)} Tickets are not failed: they stay in the queue without penalty and work resumes by itself once the limit resets. Nothing needs doing.`.replace(
      / {2,}/g,
      ' ',
    ),
  };
};

/**
 * After a runtimes report, hello, or a change of a project's account: raise or clear the notices of the workstation, one per
 * (scope, account, organization). Closed when the account reports ok.
 */
export async function syncProviderAccountNotices(ctx: Ctx, ws: WsRef, runtimes: Report[]): Promise<void> {
  const w = await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id]);
  if (!w) return;
  const cap = await one<{ capable: boolean }>(
    ctx.pool,
    'SELECT $2 = ANY (capabilities) AS capable FROM workstation_capabilities WHERE workstation_id=$1',
    [ws.id, PROVIDER_ACCOUNTS_CAPABILITY],
  );
  const capable = cap?.capable === true;
  const utc = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
  const { login, usage } = await withAppendTx(ctx.pool, async (tx) => {
    const orgs = await agentOrgs(tx, ws.id);
    const refs = await projectRefs(tx, orgs);
    const wantedLogin: Notice[] = [];
    const wantedUsage: Notice[] = [];
    const add = (
      list: Notice[],
      subkind: string,
      key: string,
      orgId: string,
      t: { title: string; body: string },
    ) => list.push({ key, subkind, ...t, orgIds: [orgId], mail: { subject: t.title, text: `${t.body}\n` } });

    // the main account of Codex and the Gemini CLI, where the workstation has agents on that runtime
    const mainRuntimes = await rows<{ org_id: string; runtime: string }>(
      tx,
      `SELECT DISTINCT org_id, runtime FROM agents WHERE workstation_id=$1 AND status='active' AND runtime IN ('codex','gemini')`,
      [ws.id],
    );
    const all: Ref[] = [
      ...refs,
      ...mainRuntimes
        .filter(
          (m) =>
            !refs.some((r) => r.orgId === m.org_id && r.scope === m.runtime && r.account === MAIN_ACCOUNT),
        )
        .map((m) => ({ orgId: m.org_id, scope: m.runtime, account: MAIN_ACCOUNT, projects: [] })),
    ];
    for (const ref of all) {
      const key = `${ref.scope}:${ref.account}`;
      if (isLoginScope(ref.scope)) {
        const rt = runtimes.find((r) => r.id === ref.scope);
        if (!rt) continue; // the program is not installed: the Integrations page says so
        const entry = rt.accounts?.find((a) => a.key === ref.account);
        let problem: ProviderAccountProblem | null = null;
        if (entry) {
          if (entry.login === 'expired' || entry.login === 'none') problem = entry.login;
        } else if (rt.accounts === undefined && ref.account !== MAIN_ACCOUNT) problem = 'old_runner';
        else if (!entry && ref.account !== MAIN_ACCOUNT) problem = capable ? 'missing' : 'old_runner';
        if (problem)
          add(
            wantedLogin,
            PROVIDER_ACCOUNT_LOGIN_SUBKIND,
            `provider_account:${ws.id}:${key}`,
            ref.orgId,
            providerAccountLoginText(w.name, ref.scope, ref.account, problem, ref.projects),
          );
        const limited =
          entry?.usage === 'limited' &&
          entry.limitedUntil &&
          new Date(entry.limitedUntil).getTime() > ctx.clock.now().getTime()
            ? entry
            : undefined;
        if (limited?.limitedUntil)
          add(
            wantedUsage,
            PROVIDER_ACCOUNT_USAGE_SUBKIND,
            `provider_account_usage:${ws.id}:${key}`,
            ref.orgId,
            providerAccountUsageText(
              w.name,
              ref.scope,
              ref.account,
              limited.limitedLabel ?? utc(limited.limitedUntil),
              ref.projects,
            ),
          );
      } else if (isKeyScope(ref.scope) && ref.account !== MAIN_ACCOUNT) {
        if (!capable && ref.account !== ORG_ACCOUNT) {
          add(
            wantedLogin,
            PROVIDER_ACCOUNT_LOGIN_SUBKIND,
            `provider_account:${ws.id}:${key}`,
            ref.orgId,
            providerAccountLoginText(w.name, ref.scope, ref.account, 'old_runner', ref.projects),
          );
        } else if (!keyAccountUsable(runtimes as never, ref.scope as ProviderKeyId, ref.account, ref.orgId))
          add(
            wantedLogin,
            PROVIDER_ACCOUNT_LOGIN_SUBKIND,
            `provider_account:${ws.id}:${key}`,
            ref.orgId,
            providerAccountLoginText(w.name, ref.scope, ref.account, 'no_key', ref.projects),
          );
      }
    }
    const l = await reconcile(
      ctx,
      tx,
      ws,
      PROVIDER_ACCOUNT_LOGIN_SUBKIND,
      `provider_account:${ws.id}:`,
      wantedLogin,
    );
    const u = await reconcile(
      ctx,
      tx,
      ws,
      PROVIDER_ACCOUNT_USAGE_SUBKIND,
      `provider_account_usage:${ws.id}:`,
      wantedUsage,
    );
    return { login: l, usage: u };
  });
  await sendMails(ctx, ws, [...login, ...usage]);
}
