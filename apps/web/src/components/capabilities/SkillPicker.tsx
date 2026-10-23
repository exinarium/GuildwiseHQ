import { useMemo, useState } from 'react';
import { usableOnly, useCapabilities } from '../../api/queries/capabilities.ts';
import { Badge, Button } from '../ui.tsx';
import { SourceBadge } from './badges.tsx';

const MAX_SHOWN = 8;

/**
 * Picks the registry skills a role is granted. The stored value stays a list of keys (`git`, `bmad:create-epics-and-stories`);
 * only skills that can be used now are offered, so an unapproved pack's skills never appear. A key that is not in the
 * registry (typed by hand, or from a pack that is no longer approved) is kept and marked.
 */
export function SkillPicker({
  value,
  onChange,
  disabled = false,
  projectId,
}: {
  value: readonly string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  projectId?: string | undefined;
}) {
  const q = useCapabilities({ kind: 'skill', usable: true, ...(projectId ? { projectId } : {}) });
  const [search, setSearch] = useState('');
  const all = useMemo(() => usableOnly(q.data?.items).filter((i) => i.kind === 'skill'), [q.data]);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  const needle = search.trim().toLowerCase();
  const matches = all.filter(
    (i) =>
      !value.includes(i.key) &&
      (!needle ||
        `${i.key} ${i.name} ${i.description} ${(i.tags ?? []).join(' ')}`.toLowerCase().includes(needle)),
  );
  const shown = matches.slice(0, MAX_SHOWN);
  const add = (key: string) => onChange([...new Set([...value, key])]);

  if (q.isPending || all.length === 0) return null;
  return (
    <div className="mt-2 rounded-control border border-line p-2" data-testid="skill-picker">
      <p className="text-sm font-medium text-fg">Pick from the registry</p>
      {value.some((k) => byKey.has(k) || k.includes(':')) && (
        <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Granted registry skills">
          {value.map((k) => {
            const hit = byKey.get(k);
            if (!hit && !k.includes(':')) return null;
            return (
              <li key={k} className="flex items-center gap-1" data-testid={`granted-${k}`}>
                <Badge tone="blue">{k}</Badge>
                {hit ? (
                  <SourceBadge source={hit.source} pack={hit.pack} />
                ) : (
                  <Badge
                    tone="amber"
                    title="This pack skill is not usable now: the pack is not approved, was removed or changed."
                  >
                    not usable now
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <input
        type="search"
        aria-label="Search registry skills"
        className="mt-2 w-full rounded-control border border-control bg-surface px-2.5 py-1.5 text-sm"
        placeholder="Search skills"
        value={search}
        disabled={disabled}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="mt-1 flex flex-col gap-1" data-testid="skill-options">
        {shown.map((i) => (
          <li key={i.key} className="flex items-start gap-2 text-sm">
            <Button
              size="sm"
              disabled={disabled}
              aria-label={`Add skill ${i.key}`}
              onClick={() => add(i.key)}
            >
              + Add
            </Button>
            <span className="min-w-0">
              <span className="font-medium text-fg">{i.name}</span>{' '}
              <code className="text-xs text-muted">{i.key}</code>{' '}
              <SourceBadge source={i.source} pack={i.pack} />
              {i.hasScripts && <Badge tone="amber">scripts</Badge>}
              <span className="block text-xs text-muted [overflow-wrap:anywhere]">{i.description}</span>
            </span>
          </li>
        ))}
        {matches.length === 0 && <li className="text-xs text-subtle">No more registry skills match.</li>}
      </ul>
      {matches.length > shown.length && (
        <p className="mt-1 text-xs text-subtle">{matches.length - shown.length} more: refine the search.</p>
      )}
    </div>
  );
}
