import type { PackTeamResponse } from '@aom/shared';
import { useEffect, useMemo, useState } from 'react';
import { usePackTeam, useSetClassification } from '../../api/queries/pack-team.ts';
import { Badge, Button, Callout, ErrorBox, ListSkeleton, TextInput, useToast } from '../ui.tsx';
import { HirePackTeamDialog } from './HirePackTeamDialog.tsx';

type TeamSkill = PackTeamResponse['skills'][number];

/** Rows shown per open group before "Show more": a pack can hold a hundred skills, so a group never renders them all at once. */
const GROUP_PAGE = 40;
/** A prefix shared by fewer skills than this does not make a group. */
const MIN_GROUP = 3;

/**
 * Groups skills by the first word of their key (`backend-development-api-design` goes under `backend`): a pack of plugin
 * folders usually names its skills after the plugin. A prefix that fewer than three skills share falls under "Other".
 */
export function groupSkills(skills: readonly TeamSkill[]): Array<{ name: string; items: TeamSkill[] }> {
  const by = new Map<string, TeamSkill[]>();
  for (const s of skills) {
    const head = s.key.includes('-') ? s.key.split('-')[0] : '';
    by.set(head ?? '', [...(by.get(head ?? '') ?? []), s]);
  }
  const groups: Array<{ name: string; items: TeamSkill[] }> = [];
  const other: TeamSkill[] = [];
  for (const [name, items] of by) {
    if (name && items.length >= MIN_GROUP) groups.push({ name, items });
    else other.push(...items);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  if (other.length) groups.push({ name: 'Other', items: other.sort((a, b) => a.key.localeCompare(b.key)) });
  return groups;
}

const matches = (s: TeamSkill, needle: string) =>
  !needle || `${s.key} ${s.name} ${s.description}`.toLowerCase().includes(needle);

/**
 * The Team part of a pack (Settings > Capabilities > Packs): what the pack supplies as agents, the Owner's toggles that say
 * which skills are agents and which are playbooks, and the way into "Hire the whole pack". Only for a pack that is approved.
 */
export function PackTeamSection({ packId, packName }: { packId: string; packName: string }) {
  const q = usePackTeam(packId);
  const save = useSetClassification(packId);
  const toast = useToast();
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [playbooks, setPlaybooks] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [more, setMore] = useState<Record<string, number>>({});
  const [hiring, setHiring] = useState(false);
  const data = q.data;

  // the draft follows the server's lists (first load, and after a save)
  useEffect(() => {
    if (!data) return;
    setAgents(new Set(data.classification.agents));
    setPlaybooks(new Set(data.classification.playbooks));
  }, [data]);

  const needle = search.trim().toLowerCase();
  const groups = useMemo(() => groupSkills(data?.skills ?? []), [data?.skills]);
  const shownGroups = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, hits: g.items.filter((s) => matches(s, needle)) }))
        .filter((g) => g.hits.length > 0),
    [groups, needle],
  );
  const dirty =
    !!data &&
    (agents.size !== data.classification.agents.length ||
      playbooks.size !== data.classification.playbooks.length ||
      data.classification.agents.some((k) => !agents.has(k)) ||
      data.classification.playbooks.some((k) => !playbooks.has(k)));

  const mark = (key: string, as: 'agent' | 'playbook', on: boolean) => {
    const a = new Set(agents);
    const p = new Set(playbooks);
    a.delete(key);
    p.delete(key);
    if (on) (as === 'agent' ? a : p).add(key);
    setAgents(a);
    setPlaybooks(p);
  };
  const submit = () =>
    save.mutate(
      { agents: [...agents].sort(), playbooks: [...playbooks].sort() },
      { onSuccess: () => toast.success('Saved. The agents and playbooks of this pack follow your marks.') },
    );
  const toggleGroup = (name: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (!n.delete(name)) n.add(name);
      return n;
    });

  if (q.isPending) return <ListSkeleton label="Loading the team" rows={2} />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!data) return null;
  const auto = data.agents.filter((a) => !a.marked);
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3" data-testid="pack-team">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-base font-semibold text-fg">Team</h4>
        <Badge data-testid="team-agent-count">
          {data.agents.length} agent{data.agents.length === 1 ? '' : 's'}
        </Badge>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={data.agents.length === 0}
          onClick={() => setHiring(true)}
          data-testid="hire-whole-pack"
        >
          Hire the whole pack…
        </Button>
      </div>
      <p className="text-sm text-muted">
        Agents of this pack join the agents you already have, each on a role (a seat) that decides what it may
        do. A persona (<code>agents/*.md</code>, <code>personas/*.md</code>) is an agent by itself
        {auto.length > 0 ? ` (${auto.length} found here)` : ''}. Many packs hold agents as skills with no
        marker: tick <strong>Agent</strong> for those below. Tick <strong>Playbook</strong> for a skill that
        is a guided workflow; it then shows in the <code>/</code> menu.
      </p>

      {data.skills.length === 0 ? (
        <p className="text-sm text-muted">This pack has no skills to mark.</p>
      ) : (
        <>
          <TextInput
            label="Search skills"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`${data.skills.length} skills in ${packName}`}
            data-testid="team-search"
          />
          <ul className="flex flex-col gap-1" data-testid="team-groups">
            {shownGroups.map((g) => {
              const isOpen = needle ? true : open.has(g.name);
              const limit = more[g.name] ?? GROUP_PAGE;
              const marked = g.items.filter((s) => agents.has(s.key) || playbooks.has(s.key)).length;
              return (
                <li
                  key={g.name}
                  className="rounded-control border border-line"
                  data-testid={`team-group-${g.name}`}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium [@media(pointer:coarse)]:min-h-11"
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(g.name)}
                  >
                    <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    {g.name}
                    <span className="text-xs font-normal text-subtle">
                      {needle ? `${g.hits.length} of ${g.items.length}` : g.items.length}
                      {marked > 0 ? `, ${marked} marked` : ''}
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="flex flex-col divide-y divide-line border-t border-line">
                      {g.hits.slice(0, limit).map((s) => {
                        const locked = !s.marked && s.class !== 'skill';
                        return (
                          <li
                            key={s.key}
                            className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2"
                            data-testid={`team-skill-${s.key}`}
                          >
                            <div className="min-w-0 flex-1 basis-60">
                              <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{s.name}</p>
                              <p className="line-clamp-2 text-xs text-muted">{s.description}</p>
                            </div>
                            {locked ? (
                              <Badge tone="violet" data-testid={`team-auto-${s.key}`}>
                                {s.class === 'agent'
                                  ? 'Agent (found in the pack)'
                                  : 'Playbook (found in the pack)'}
                              </Badge>
                            ) : (
                              <div className="flex gap-4 text-sm">
                                <label className="flex items-center gap-1.5">
                                  <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={agents.has(s.key)}
                                    onChange={(e) => mark(s.key, 'agent', e.target.checked)}
                                    aria-label={`Agent: ${s.name}`}
                                  />
                                  Agent
                                </label>
                                <label className="flex items-center gap-1.5">
                                  <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={playbooks.has(s.key)}
                                    onChange={(e) => mark(s.key, 'playbook', e.target.checked)}
                                    aria-label={`Playbook: ${s.name}`}
                                  />
                                  Playbook
                                </label>
                              </div>
                            )}
                          </li>
                        );
                      })}
                      {g.hits.length > limit && (
                        <li className="px-3 py-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setMore({ ...more, [g.name]: limit + GROUP_PAGE })}
                          >
                            Show {Math.min(GROUP_PAGE, g.hits.length - limit)} more of {g.hits.length - limit}
                          </Button>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {shownGroups.length === 0 && <p className="text-sm text-muted">No skill matches “{search}”.</p>}
          <ErrorBox error={save.error} />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={submit}
              data-testid="save-classification"
            >
              Save marks
            </Button>
            {dirty && <span className="text-xs text-subtle">Unsaved changes</span>}
          </div>
        </>
      )}
      {hiring && <HirePackTeamDialog packId={packId} packName={packName} onClose={() => setHiring(false)} />}
      {!data.trusted && <Callout tone="warning">This pack is not approved yet.</Callout>}
    </div>
  );
}
