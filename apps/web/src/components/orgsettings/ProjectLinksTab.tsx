import type { OrgLinkEndpoint, OrgLinkKind } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import {
  useAssertOrgGraphLink,
  useOrgGraphLinks,
  useRetractOrgGraphLink,
} from '../../api/queries/orgGraph.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { Button, EmptyState, ErrorBox, ListSkeleton, Panel, Select, TextInput } from '../ui.tsx';

const KIND_LABEL: Record<OrgLinkKind, string> = {
  depends_on: 'depends on',
  uses: 'uses',
  related: 'is related to',
};

const NAME = '__name__';

/**
 * Links between projects that you assert (docs/design/project-graphs.md section 8): pick a project, or type a name for
 * something outside Guildwise. What the code suggests is not shown here and not sent to Guildwise HQ: the CEO shows those
 * suggestions in chat, and you accept them there.
 */
export function ProjectLinksTab() {
  const links = useOrgGraphLinks();
  const projects = useProjects();
  const assert = useAssertOrgGraphLink();
  const retract = useRetractOrgGraphLink();
  const [fromSel, setFromSel] = useState('');
  const [toSel, setToSel] = useState('');
  const [fromName, setFromName] = useState('');
  const [toName, setToName] = useState('');
  const [kind, setKind] = useState<OrgLinkKind>('depends_on');
  const [note, setNote] = useState('');
  const list = projects.data ?? [];
  const from = fromSel || list[0]?.id || '';
  const to = toSel || list[1]?.id || list[0]?.id || '';

  const end = (sel: string, name: string): OrgLinkEndpoint | null =>
    sel === NAME ? (name.trim() ? { name: name.trim() } : null) : sel ? { projectId: sel } : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = end(from, fromName);
    const b = end(to, toName);
    if (!a || !b) return;
    assert.mutate(
      { from: a, to: b, kind, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setNote('');
          setFromName('');
          setToName('');
        },
      },
    );
  };
  const options = (
    <>
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.key} {p.name}
        </option>
      ))}
      <option value={NAME}>Something else (type a name)</option>
    </>
  );
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Links between projects">
        <p className="mb-3 text-sm text-muted">
          Tell Guildwise how your projects belong together. The CEO uses these links to decide which project a
          request is for. Only the project and the names you type are kept; what your code suggests stays on
          your workstation, and the CEO shows it to you in chat.
        </p>
        {links.isPending && <ListSkeleton label="Loading links" rows={2} />}
        {links.data?.length === 0 && (
          <EmptyState bare title="No links yet" description="Add the first one below." />
        )}
        <ul className="divide-y divide-line text-sm" data-testid="org-links">
          {links.data?.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
              data-testid={`org-link-${l.id}`}
            >
              <span className="font-medium text-fg">{l.from.label}</span>
              <span className="text-muted">{KIND_LABEL[l.kind]}</span>
              <span className="font-medium text-fg">{l.to.label}</span>
              {l.note && <span className="text-xs text-subtle">{l.note}</span>}
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                aria-label={`Remove the link ${l.from.label} to ${l.to.label}`}
                loading={retract.isPending && retract.variables === l.id}
                onClick={() => retract.mutate(l.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <ErrorBox error={retract.error} />
      </Panel>
      <Panel title="Add a link">
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Add a link">
          <div className="grid gap-3 sm:grid-cols-3">
            <Select label="From" value={from} onChange={(e) => setFromSel(e.target.value)}>
              {options}
            </Select>
            <Select label="Link" value={kind} onChange={(e) => setKind(e.target.value as OrgLinkKind)}>
              {(Object.keys(KIND_LABEL) as OrgLinkKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
            <Select label="To" value={to} onChange={(e) => setToSel(e.target.value)}>
              {options}
            </Select>
          </div>
          {from === NAME && (
            <TextInput
              label="Name of the first end"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
            />
          )}
          {to === NAME && (
            <TextInput
              label="Name of the second end"
              value={toName}
              onChange={(e) => setToName(e.target.value)}
            />
          )}
          <TextInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <ErrorBox error={assert.error} />
          <Button type="submit" variant="primary" loading={assert.isPending} className="self-end">
            Add the link
          </Button>
        </form>
      </Panel>
    </div>
  );
}
