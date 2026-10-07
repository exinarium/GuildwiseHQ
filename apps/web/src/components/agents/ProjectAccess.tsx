import type { AgentDto, ProjectDto } from '@aom/shared';
import { Star } from 'lucide-react';
import { useState } from 'react';
import { useSetAllowedProjects, useSetFocusProjects } from '../../api/queries/agents.ts';
import { HelpHint } from '../help/HelpHint.tsx';
import { cx } from '../ui/cx.ts';
import { Badge, Button, Dialog, ErrorBox, Segmented } from '../ui.tsx';

/** Where an agent may work (`allowed`: null = any project) and which of those it prefers (`focus`, at most ten). */
export interface Access {
  allowed: string[] | null;
  focus: string[];
}

const MAX_FOCUS = 10;

/**
 * The per-agent project allow-list (docs/design/restructure.md, owner decision "agents: org-wide but assignable"):
 * "Any project" or a hand-picked list, plus a star on the projects the agent should prefer. An agent belongs to one
 * organization, so once a project is picked the projects of other organizations are not offered.
 */
export function ProjectAccessEditor({
  value,
  onChange,
  projects,
  canAny,
  idPrefix = 'access',
}: {
  value: Access;
  onChange: (v: Access) => void;
  projects: ProjectDto[];
  /** "Any project" is for the organization's Owner and Admins. */
  canAny: boolean;
  idPrefix?: string;
}) {
  const any = value.allowed === null;
  const picked = value.allowed ?? [];
  const lockedOrg = projects.find((p) => picked.includes(p.id))?.orgId;
  const guestLabel = (p: ProjectDto) => (p.orgName && lockedOrg !== p.orgId ? p.orgName : null);
  const setAllowed = (allowed: string[] | null) =>
    onChange({
      allowed,
      focus: allowed === null ? value.focus : value.focus.filter((f) => allowed.includes(f)),
    });
  const toggleAllowed = (id: string, on: boolean) =>
    setAllowed(on ? [...picked, id] : picked.filter((x) => x !== id));
  const toggleFocus = (id: string) =>
    onChange({
      ...value,
      focus: value.focus.includes(id)
        ? value.focus.filter((x) => x !== id)
        : [...value.focus, id].slice(0, MAX_FOCUS),
    });
  const options: Array<{ value: 'any' | 'some'; label: string }> = [
    ...(canAny ? [{ value: 'any' as const, label: 'Any project' }] : []),
    { value: 'some', label: 'Selected projects' },
  ];

  return (
    <fieldset className="flex flex-col gap-2" data-testid={`${idPrefix}-editor`}>
      <legend className="mb-1 text-sm font-medium text-fg">
        <span className="inline-flex items-center gap-1">
          Where may this agent work?
          <HelpHint article="agents#allow-lists" label="About the allow-list of projects">
            The allow-list is the set of projects this agent may work on. It is only offered cards from those
            projects; an empty list keeps it on the bench.
          </HelpHint>
        </span>
      </legend>
      <Segmented
        label="Allowed projects"
        value={any ? 'any' : 'some'}
        onChange={(v) => setAllowed(v === 'any' ? null : value.focus.length ? [...value.focus] : [])}
        options={options}
      />
      <p className="text-xs text-subtle">
        {any
          ? 'Any current or future project of the organization that the owner of its workstation can open.'
          : 'Only these projects. The agent also needs its workstation owner to be on the project.'}{' '}
        Star the projects it should work first.
        <HelpHint article="agents#focus" label="About focus">
          The starred projects are the agent's focus: it picks cards from them first and turns to the others
          only when there is nothing there.
        </HelpHint>
      </p>
      {projects.length === 0 ? (
        <p className="text-sm text-muted">No projects yet.</p>
      ) : (
        <ul
          className="max-h-56 divide-y divide-line overflow-y-auto rounded-control border border-line bg-surface"
          data-testid={`${idPrefix}-projects`}
        >
          {projects.map((p) => {
            const checked = any || picked.includes(p.id);
            const blocked = !any && !!lockedOrg && p.orgId !== lockedOrg && !picked.includes(p.id);
            const starred = value.focus.includes(p.id);
            const canStar = checked && (starred || value.focus.length < MAX_FOCUS);
            return (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <label className={cx('flex min-w-0 flex-1 items-center gap-2', blocked && 'opacity-50')}>
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={checked}
                    disabled={any || blocked}
                    onChange={(e) => toggleAllowed(p.id, e.target.checked)}
                    aria-label={`Allow ${p.key}`}
                  />
                  <span className="font-mono text-xs font-semibold text-fg">{p.key}</span>
                  <span className="truncate text-muted">{p.name}</span>
                  {guestLabel(p) && <Badge tone="violet">{guestLabel(p)}</Badge>}
                </label>
                <button
                  type="button"
                  aria-pressed={starred}
                  aria-label={`${starred ? 'Stop preferring' : 'Prefer'} ${p.key}`}
                  title={starred ? 'Preferred: worked first' : 'Prefer this project'}
                  disabled={!canStar}
                  onClick={() => toggleFocus(p.id)}
                  className={cx(
                    'inline-flex size-8 shrink-0 items-center justify-center rounded-control transition-colors disabled:opacity-30 [@media(pointer:coarse)]:size-11',
                    starred ? 'text-warning-soft-fg' : 'text-subtle hover:bg-sunken hover:text-fg',
                  )}
                >
                  <Star aria-hidden="true" className={cx('size-4', starred && 'fill-current')} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {value.focus.length >= MAX_FOCUS && (
        <p className="text-xs text-subtle">An agent can prefer at most {MAX_FOCUS} projects.</p>
      )}
    </fieldset>
  );
}

/** "Works on: any project" or the key chips of the allow-list, with a star on the preferred ones. */
export function WorksOn({ agent, projects }: { agent: AgentDto; projects: ProjectDto[] }) {
  const keyOf = (id: string) => projects.find((p) => p.id === id)?.key ?? 'shared project';
  if (agent.isDevops)
    return <p className="text-xs text-subtle">Works on DevOps requests and repository checks only.</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="agent-works-on">
      <span className="text-subtle">Works on</span>
      {agent.allowedProjectIds === null ? (
        <Badge tone="blue">any project</Badge>
      ) : agent.allowedProjectIds.length === 0 ? (
        <Badge tone="amber">no project (benched)</Badge>
      ) : (
        agent.allowedProjectIds.map((id) => (
          <Badge key={id} tone={agent.focusProjectIds.includes(id) ? 'violet' : 'neutral'}>
            {agent.focusProjectIds.includes(id) && (
              <Star aria-hidden="true" className="mr-0.5 size-3 fill-current" />
            )}
            {keyOf(id)}
          </Badge>
        ))
      )}
      {agent.allowedProjectIds === null &&
        agent.focusProjectIds.map((id) => (
          <Badge key={id} tone="violet">
            <Star aria-hidden="true" className="mr-0.5 size-3 fill-current" />
            {keyOf(id)}
          </Badge>
        ))}
    </div>
  );
}

/** Change where an agent may work and which projects it prefers. */
export function AllowedProjectsDialog({
  agent,
  projects,
  canAny,
  onClose,
}: {
  agent: AgentDto | null;
  projects: ProjectDto[];
  canAny: boolean;
  onClose: () => void;
}) {
  const setAllowed = useSetAllowedProjects();
  const setFocus = useSetFocusProjects();
  const [draft, setDraft] = useState<{ id: string; value: Access } | null>(null);
  const value: Access =
    draft && draft.id === agent?.id
      ? draft.value
      : { allowed: agent?.allowedProjectIds ?? null, focus: agent?.focusProjectIds ?? [] };
  const save = async () => {
    if (!agent) return;
    try {
      await setAllowed.mutateAsync({ id: agent.id, projectIds: value.allowed });
      await setFocus.mutateAsync({ id: agent.id, projectIds: value.focus });
      setDraft(null);
      onClose();
    } catch {
      // the ErrorBox below shows it
    }
  };
  return (
    <Dialog
      open={!!agent}
      onOpenChange={(o) => {
        if (!o) {
          setDraft(null);
          onClose();
        }
      }}
      title={`Allowed projects for ${agent?.name ?? ''}`}
      description="Decide where this agent may work. The dispatcher only offers it cards of these projects."
    >
      {agent && (
        <form
          aria-label="Allowed projects"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <ProjectAccessEditor
            value={value}
            onChange={(v) => setDraft({ id: agent.id, value: v })}
            projects={projects.filter((p) => p.orgId === agent.orgId)}
            canAny={canAny}
            idPrefix="allowed"
          />
          <ErrorBox error={setAllowed.error ?? setFocus.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={setAllowed.isPending || setFocus.isPending}
              data-testid="allowed-save"
            >
              Save
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
