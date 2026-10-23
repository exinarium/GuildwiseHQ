import type { PackDiff } from '@aom/shared';
import { Badge } from '../ui.tsx';

/** What changed between the approved commit and the update on offer. Scripts that are new or changed stand out. */
export function PackDiffView({ diff }: { diff: PackDiff }) {
  const scripts = [...diff.scriptsAdded, ...diff.scriptsChanged];
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pack-diff">
      <p className="text-muted">
        {diff.counts.filesAdded} files added, {diff.counts.filesChanged} changed, {diff.counts.filesRemoved}{' '}
        removed.
      </p>
      {!diff.hasChanges && <p>No capability changed.</p>}
      {scripts.length > 0 && (
        <div
          role="alert"
          className="rounded-control border border-warning-fill/50 bg-warning-soft p-2 text-warning-soft-fg"
          data-testid="diff-scripts"
        >
          <p className="font-medium">Script files are new or changed in this version</p>
          <ul className="mt-1 list-disc pl-5">
            {diff.scriptsAdded.map((f) => (
              <li key={`a-${f}`}>
                <code>{f}</code> (added)
              </li>
            ))}
            {diff.scriptsChanged.map((f) => (
              <li key={`c-${f}`}>
                <code>{f}</code> (changed)
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff.addedCapabilities.length > 0 && (
        <section aria-label="Added capabilities">
          <h4 className="font-medium text-fg">Added</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {diff.addedCapabilities.map((c) => (
              <li key={c.id}>
                <Badge tone="green">added</Badge> {c.name} <code className="text-xs text-muted">{c.id}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.removedCapabilities.length > 0 && (
        <section aria-label="Removed capabilities">
          <h4 className="font-medium text-fg">Removed</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {diff.removedCapabilities.map((c) => (
              <li key={c.id}>
                <Badge tone="red">removed</Badge> {c.name} <code className="text-xs text-muted">{c.id}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.changedCapabilities.length > 0 && (
        <section aria-label="Changed capabilities">
          <h4 className="font-medium text-fg">Changed</h4>
          <ul className="mt-1 flex flex-col gap-2">
            {diff.changedCapabilities.map((c) => (
              <li key={c.id} data-testid={`changed-${c.id}`}>
                <Badge tone="blue">changed</Badge> {c.name} <code className="text-xs text-muted">{c.id}</code>
                <ul className="ml-4 list-disc text-xs text-muted">
                  {c.addedFiles.map((f) => (
                    <li key={`a-${f}`}>
                      <code>{f}</code> added
                    </li>
                  ))}
                  {c.changedFiles.map((f) => (
                    <li key={`c-${f}`}>
                      <code>{f}</code> changed
                    </li>
                  ))}
                  {c.removedFiles.map((f) => (
                    <li key={`r-${f}`}>
                      <code>{f}</code> removed
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
