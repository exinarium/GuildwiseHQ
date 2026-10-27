import { CLAUDE_ACCOUNTS_CAPABILITY, DESK_SUBKIND } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { agentOrgs, type Notice, reconcile, sendMails, type WsRef } from './workstation-notices.ts';

/**
 * Desk notices about per-project Claude accounts (docs/design/claude-accounts.md section 2.5): a limited account, and an
 * account that needs a sign-in (D4: an expired or never completed login counts like a hit limit).
 */

/** Desk subkind of the "Claude account needs a sign-in" notice. */
export const CLAUDE_ACCOUNT_LOGIN_SUBKIND = 'claude_account_login';

export interface AccountEntry {
  key: string;
  main?: boolean;
  login?: string;
  usage?: string;
  limitedUntil?: string;
  limitedLabel?: string;
  configDir?: string;
  detail?: string;
}

export interface ClaudeRuntimeReport {
  id: string;
  auth?: string | undefined;
  usage?: string | undefined;
  limitedUntil?: string | undefined;
  limitedLabel?: string | undefined;
  accounts?: AccountEntry[] | undefined;
}

interface Ref {
  orgId: string;
  key: string;
  projects: Array<{ key: string; fallback: boolean }>;
}

/** Projects (per organization) that name a Claude account, in the organizations the workstation's agents belong to. */
async function projectsByAccount(tx: Tx, orgIds: string[]): Promise<Ref[]> {
  const list = await rows<{ org_id: string; account: string; pkey: string; fallback: boolean }>(
    tx,
    `SELECT org_id, claude_account_key AS account, key AS pkey, claude_account_fallback AS fallback
       FROM projects WHERE status='active' AND claude_account_key IS NOT NULL AND org_id = ANY($1::uuid[])
      ORDER BY key`,
    [orgIds],
  );
  const out = new Map<string, Ref>();
  for (const r of list) {
    const k = `${r.org_id}|${r.account}`;
    const e = out.get(k) ?? { orgId: r.org_id, key: r.account, projects: [] };
    e.projects.push({ key: r.pkey, fallback: r.fallback });
    out.set(k, e);
  }
  return [...out.values()];
}

export const claudeAccountUsageText = (
  workstation: string,
  account: string,
  resumes: string,
  projects: Array<{ key: string; fallback: boolean }>,
): { title: string; body: string } => {
  const fb = projects.filter((p) => p.fallback).map((p) => p.key);
  const paused = projects.filter((p) => !p.fallback).map((p) => p.key);
  const effect = [
    fb.length > 0 ? `Projects ${fb.join(', ')} fall back to the main account.` : '',
    paused.length > 0 ? `Projects ${paused.join(', ')} are paused.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    title: `Claude account ${account} reached its usage limit on ${workstation}`,
    body: `Account \`${account}\` on ${workstation} reached its usage limit until ${resumes}. ${effect} Tickets are not failed: they stay in the queue without penalty and work resumes by itself once the limit resets. Nothing needs doing.`,
  };
};

/** The usage notices for limited non-main accounts that projects of the workstation's organizations name. */
export async function accountUsageNotices(
  tx: Tx,
  workstationName: string,
  claude: ClaudeRuntimeReport | undefined,
  orgs: string[],
  now: Date,
  keyBase: string,
  utcLabel: (iso: string) => string,
): Promise<Notice[]> {
  const limited = (claude?.accounts ?? []).filter(
    (a) =>
      !a.main &&
      a.key !== 'main' &&
      a.usage === 'limited' &&
      !!a.limitedUntil &&
      new Date(a.limitedUntil).getTime() > now.getTime(),
  );
  if (limited.length === 0) return [];
  const out: Notice[] = [];
  for (const ref of await projectsByAccount(tx, orgs)) {
    const a = limited.find((x) => x.key === ref.key);
    if (!a?.limitedUntil) continue;
    const text = claudeAccountUsageText(
      workstationName,
      a.key,
      a.limitedLabel ?? utcLabel(a.limitedUntil),
      ref.projects,
    );
    out.push({
      key: `${keyBase}:${a.key}`,
      subkind: DESK_SUBKIND.claudeUsageLimit,
      ...text,
      orgIds: [ref.orgId],
      mail: { subject: text.title, text: `${text.body}\n` },
    });
  }
  return out;
}

type Problem = 'expired' | 'none' | 'old_runner' | 'needs_owner' | 'failed' | 'awaiting_login';

/** The sign-in notice for a project's account: what is wrong and how to fix it, browser first. */
export function claudeAccountLoginText(
  workstation: string,
  account: string,
  problem: Problem,
  opts: {
    configDir?: string | undefined;
    detail?: string | undefined;
    fallback: boolean;
    projects: string[];
  },
): { title: string; body: string } {
  const dir = opts.configDir ?? `~/.claude-gw-${account}`;
  const effect = `Tickets of ${opts.projects.length === 1 ? 'project' : 'projects'} ${opts.projects.join(', ')} ${
    opts.fallback ? 'run on the main account meanwhile.' : 'are paused (not failed) until it works.'
  }`;
  const browser = `Sign in from the browser: open the Integrations page of ${workstation} (link claude-code:${account}), choose "Sign in with your Claude subscription", open the link and paste the code back.`;
  const terminal = `Or in a terminal on ${workstation}: \`claude-gw-${account}\` and then \`/login\` (the same as \`CLAUDE_CONFIG_DIR=${dir} claude auth login\`).`;
  if (problem === 'old_runner')
    return {
      title: `Update the runner on ${workstation} to use Claude account ${account}`,
      body: `Projects name the Claude account \`${account}\`, but the runner on ${workstation} is too old to use accounts: update the runner to 0.1.33 or later. ${effect}`,
    };
  if (problem === 'needs_owner')
    return {
      title: `Claude account ${account} must be set up on ${workstation}`,
      body: `The runner on ${workstation} may not change your home folder from the web. On that machine run \`guildwise-runner accounts add ${account}\` and then \`guildwise-runner accounts login ${account}\`. ${effect}`,
    };
  if (problem === 'failed')
    return {
      title: `Claude account ${account} could not be set up on ${workstation}`,
      body: `${opts.detail ?? 'The runner could not create the account.'} Run \`guildwise-runner accounts add ${account}\` on ${workstation}, then \`guildwise-runner accounts login ${account}\`. ${effect}`,
    };
  const what = problem === 'expired' ? 'login has expired' : 'has not been signed in yet';
  return {
    title: `Claude account ${account} needs a sign-in on ${workstation}`,
    body: `The Claude account \`${account}\` on ${workstation} ${what}. ${browser} ${terminal} ${effect}`,
  };
}

/**
 * After a runtimes report, hello or a provisioning answer: raise or clear the "Claude account needs a sign-in" notices
 * of the workstation, one per (project account, organization). An account needs attention when the runner reports it
 * with `login` none or expired, or does not report it and either cannot (old runner) or answered that it could not
 * provision it (`claude.account.ensure`: needs_owner, failed, awaiting_login). Closed when the account reports ok.
 */
export async function syncClaudeAccountNotices(
  ctx: Ctx,
  ws: WsRef,
  runtimes: ClaudeRuntimeReport[],
): Promise<void> {
  const w = await one<{
    name: string;
    ensure: Record<string, { state?: string; detail?: string; configDir?: string }> | null;
  }>(ctx.pool, 'SELECT name, claude_account_ensure AS ensure FROM workstations WHERE id=$1', [ws.id]);
  if (!w) return;
  const cap = await one<{ capable: boolean }>(
    ctx.pool,
    'SELECT $2 = ANY (capabilities) AS capable FROM workstation_capabilities WHERE workstation_id=$1',
    [ws.id, CLAUDE_ACCOUNTS_CAPABILITY],
  );
  const capable = cap?.capable === true;
  const claude = runtimes.find((r) => r.id === 'claude-code');
  const mails = await withAppendTx(ctx.pool, async (tx) => {
    const wanted: Notice[] = [];
    // Only a workstation with a Claude Code runtime runs account work at all.
    if (claude) {
      for (const ref of await projectsByAccount(tx, await agentOrgs(tx, ws.id))) {
        const entry = claude.accounts?.find((a) => a.key === ref.key);
        const ensure = w.ensure?.[ref.key];
        let problem: Problem | null = null;
        if (entry) {
          if (entry.login === 'expired' || entry.login === 'none') problem = entry.login;
        } else if (!capable) problem = 'old_runner';
        else if (
          ensure?.state === 'needs_owner' ||
          ensure?.state === 'failed' ||
          ensure?.state === 'awaiting_login'
        )
          problem = ensure.state;
        if (!problem) continue;
        const text = claudeAccountLoginText(w.name, ref.key, problem, {
          configDir: entry?.configDir ?? ensure?.configDir,
          detail: entry?.detail ?? ensure?.detail,
          fallback: ref.projects.every((p) => p.fallback),
          projects: ref.projects.map((p) => p.key),
        });
        wanted.push({
          key: `claude_account:${ws.id}:${ref.key}`,
          subkind: CLAUDE_ACCOUNT_LOGIN_SUBKIND,
          ...text,
          orgIds: [ref.orgId],
          mail: { subject: text.title, text: `${text.body}\n` },
        });
      }
    }
    return reconcile(ctx, tx, ws, CLAUDE_ACCOUNT_LOGIN_SUBKIND, `claude_account:${ws.id}:`, wanted);
  });
  await sendMails(ctx, ws, mails);
}
