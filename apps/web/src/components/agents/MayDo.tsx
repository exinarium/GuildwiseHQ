import { type AgentMayDo, GATE_INFO } from '@aom/shared';
import { type ReactNode, useState } from 'react';
import { useMayDo, useSetAgentGate } from '../../api/queries/governance.ts';
import { money } from '../../lib/money.ts';
import { Badge, Button, Callout, Dialog, ErrorBox, Skeleton } from '../ui.tsx';

const KEY_TEXT: Record<AgentMayDo['provider']['keySource'], string> = {
  org: 'The organization’s key (counted against its monthly cap)',
  workstation: 'Its owner’s own key on the workstation (not counted against the organization)',
  login: 'A subscription login on the workstation',
  unknown: 'Not known yet: it has not done any billed work',
};

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5 border-b border-line py-3 last:border-0">
      <h3 id={id} className="text-sm font-semibold text-fg">
        {title}
      </h3>
      {children}
    </section>
  );
}

const Chips = ({ items, empty }: { items: string[]; empty: string }) =>
  items.length === 0 ? (
    <p className="text-sm text-subtle">{empty}</p>
  ) : (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <li key={i}>
          <Badge>{i}</Badge>
        </li>
      ))}
    </ul>
  );

function Gates({ d }: { d: AgentMayDo }) {
  const set = useSetAgentGate(d.agentId);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        An agent normally just does these. Switch a gate on and the action pauses and lands on the Desk as an
        approval; the agent goes on after you approve it (once per approval).
      </p>
      <ul className="flex flex-col gap-2">
        {d.gates.map((g) => {
          const fixed = g.enforcement !== 'opt_in';
          const mayChange = g.gated ? d.canUngate : d.canGate;
          const info = GATE_INFO[g.actionClass];
          return (
            <li key={g.actionClass} className="flex items-start gap-3" data-testid={`gate-${g.actionClass}`}>
              <input
                id={`gate-${d.agentId}-${g.actionClass}`}
                type="checkbox"
                className="mt-1 size-4"
                checked={g.gated}
                disabled={fixed || !mayChange || set.isPending}
                onChange={(e) => set.mutate({ actionClass: g.actionClass, gated: e.target.checked })}
              />
              <label htmlFor={`gate-${d.agentId}-${g.actionClass}`} className="flex flex-col text-sm">
                <span className="font-medium text-fg">
                  Ask me before: {g.label.toLowerCase()}
                  {g.enforcement === 'always' && <Badge className="ml-2">Always asks</Badge>}
                  {g.enforcement === 'not_enforced' && (
                    <Badge tone="warning" className="ml-2">
                      Not available yet
                    </Badge>
                  )}
                  {g.pending > 0 && (
                    <Badge tone="amber" className="ml-2">
                      {g.pending} waiting
                    </Badge>
                  )}
                </span>
                <span className="text-muted">{g.description}</span>
                <span className="text-subtle">{fixed || g.gated ? info.note : ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {!d.canGate && (
        <Callout tone="info">Only an Owner, an Admin or the agent’s manager switches a gate on.</Callout>
      )}
      {d.canGate && !d.canUngate && (
        <Callout tone="info">Only an Owner or an Admin switches a gate off again.</Callout>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}

function Body({ agentId }: { agentId: string }) {
  const q = useMayDo(agentId);
  if (q.isPending) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const t = d.tools;
  return (
    <div data-testid="may-do">
      <Section title="Tools" id="md-tools">
        <Chips items={t.allowedTools} empty="No tools." />
        <p className="text-sm text-muted">
          {t.mayCommit ? 'Can commit to git.' : 'Cannot commit.'} {t.browser ? 'Can run a browser.' : ''}{' '}
          Works on {t.riskTiers.join(' and ')} changes.
          {t.writableGlobs ? ` May write only: ${t.writableGlobs.join(', ')}.` : ''}
        </p>
        {t.deniedShellPatterns.length > 0 && (
          <p className="text-sm text-subtle">
            Never runs: <code>{t.deniedShellPatterns.join('</code>, <code>')}</code>
          </p>
        )}
      </Section>
      <Section title="Repositories" id="md-repos">
        <p className="text-sm text-muted">
          {d.repos.repos === null
            ? 'Every repository of the projects it works on.'
            : d.repos.repos.length === 0
              ? 'None.'
              : `Only: ${d.repos.repos.map((r) => r.name).join(', ')}.`}{' '}
          {d.repos.readOrgRepos ? 'It can also read every repository of the organization.' : ''}
        </p>
      </Section>
      <Section title="Data it can reach" id="md-data">
        <p className="text-sm text-muted">
          {d.data.projects === null
            ? 'Any project of the organization.'
            : d.data.projects.length === 0
              ? 'No project: it is benched.'
              : `Projects: ${d.data.projects.map((p) => p.key).join(', ')}.`}
        </p>
        <Chips items={d.data.mcpServers.map((m) => `tool server: ${m}`)} empty="No external tool servers." />
      </Section>
      <Section title="Provider and account" id="md-provider">
        <p className="text-sm text-muted">
          {d.provider.runtime} · {d.provider.model}
          {d.provider.effort ? ` · ${d.provider.effort}` : ''}
          {d.provider.workstation ? ` · on ${d.provider.workstation}` : ''}
        </p>
        <p className="text-sm text-subtle">Pays with: {KEY_TEXT[d.provider.keySource]}</p>
      </Section>
      <Section title="May delegate to" id="md-delegation">
        {d.delegation.length === 0 ? (
          <p className="text-sm text-subtle">Nobody. Delegation is off unless granted.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {d.delegation.map((g) => (
              <li
                key={`${g.kind}:${g.handle}`}
                className={`flex flex-wrap items-center gap-2 text-sm ${g.excluded ? 'text-subtle line-through' : 'text-fg'}`}
              >
                {g.name}{' '}
                <span className="text-subtle">
                  ({g.kind}, up to {g.maxCalls} calls)
                </span>
                {g.inherited && <Badge title="Every agent of its role has this">from its role</Badge>}
                {g.excluded && <Badge tone="warning">excluded for this agent</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Playbooks, skills and packs" id="md-caps">
        <Chips items={d.playbooks.map((p) => `playbook: ${p.name}`)} empty="No playbook it may start." />
        <Chips items={d.skills.map((s) => `skill: ${s.key}`)} empty="No extra skills." />
        {d.packs.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {d.packs.map((p) => (
              <li key={p.packId} className="text-muted">
                Pack <strong className="text-fg">{p.name}</strong>
                {p.scopes.length ? ` · needs ${p.scopes.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        )}
        {d.skills.some((s) => s.scopes.length) && (
          <ul className="text-sm text-muted">
            {d.skills
              .filter((s) => s.scopes.length)
              .map((s) => (
                <li key={s.key}>
                  Skill {s.key} · needs {s.scopes.join(', ')}
                </li>
              ))}
          </ul>
        )}
      </Section>
      <Section title="Spend and budget" id="md-spend">
        {d.spend ? (
          <>
            <p className="tnum text-sm text-muted">
              {money(d.spend.monthMicros, d.spend.currency)} this month,{' '}
              {money(d.spend.totalMicros, d.spend.currency)} in total.
            </p>
            {d.spend.budgets.length === 0 ? (
              <p className="text-sm text-subtle">No budget or cap applies to it.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm text-muted">
                {d.spend.budgets.map((b) => (
                  <li key={b.label} className="tnum">
                    {b.label}: {money(b.usedMicros, d.spend?.currency)} of{' '}
                    {money(b.capMicros, d.spend?.currency)}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-sm text-subtle">No spend yet.</p>
        )}
      </Section>
      <Section title="Approval gates" id="md-gates">
        <Gates d={d} />
      </Section>
    </div>
  );
}

/** "What it may do": one view of everything that decides what an agent can do, with its approval gates. */
export function MayDoButton({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" aria-label={`What ${agentName} may do`} onClick={() => setOpen(true)}>
        What it may do
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title={`What ${agentName} may do`}
        description="Its tools, repositories, data, provider, grants, spend and approval gates in one place."
      >
        {open && <Body agentId={agentId} />}
      </Dialog>
    </>
  );
}
