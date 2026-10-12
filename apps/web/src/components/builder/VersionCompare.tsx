import {
  describeDiff,
  diffDefinitions,
  type WorkflowDefinitionInput,
  type WorkflowVersionDto,
} from '@aom/shared';
import { useState } from 'react';
import { Badge, Button } from '../ui.tsx';

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  pending_approval: 'Waiting for approval',
  draft: 'Draft',
  superseded: 'Replaced',
  rejected: 'Rejected',
};

function Changes({ lines }: { lines: string[] }) {
  return lines.length === 0 ? (
    <p className="text-xs text-subtle">No difference between the two versions.</p>
  ) : (
    <ul className="list-disc pl-5 text-sm" data-testid="diff-lines">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/**
 * The versions of one workflow, newest first, with a step-level "Compare with previous" for each
 * (docs/design/workflow-builder.md 2.5). `draft` adds a comparison of the unsaved draft with the newest approved version.
 */
export function VersionCompare({
  versions,
  draft,
}: {
  versions: readonly WorkflowVersionDto[];
  draft?: WorkflowDefinitionInput;
}) {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const approved =
    versions.find((v) => v.status === 'active') ?? versions.find((v) => v.status === 'superseded');
  return (
    <section aria-labelledby="versions-title" className="flex flex-col gap-2" data-testid="version-compare">
      <h2 id="versions-title" className="text-base font-semibold">
        Versions
      </h2>
      {versions.length === 0 && <p className="text-sm text-subtle">Nothing has been saved yet.</p>}
      <ul className="flex flex-col gap-2">
        {versions.map((v, i) => {
          const prev = versions[i + 1];
          const open = shown.has(v.id);
          return (
            <li key={v.id} data-testid={`compare-v${v.version}`} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">v{v.version}</span>
                <Badge tone={v.status === 'active' ? 'green' : v.status === 'rejected' ? 'red' : 'neutral'}>
                  {STATUS_LABEL[v.status] ?? v.status}
                </Badge>
                {prev && (
                  <Button
                    size="sm"
                    aria-expanded={open}
                    aria-label={`${open ? 'Hide' : 'Show'} what changed in v${v.version} compared with v${prev.version}`}
                    onClick={() => toggle(v.id)}
                  >
                    Compare with previous
                  </Button>
                )}
              </div>
              {prev && open && (
                <div className="mt-1 pl-1">
                  <Changes lines={describeDiff(diffDefinitions(prev.definition, v.definition))} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {draft && approved && (
        <div>
          <Button size="sm" aria-expanded={shown.has('draft')} onClick={() => toggle('draft')}>
            Compare this draft with v{approved.version}
          </Button>
          {shown.has('draft') && (
            <div className="mt-1 pl-1">
              <Changes lines={describeDiff(diffDefinitions(approved.definition, draft))} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
