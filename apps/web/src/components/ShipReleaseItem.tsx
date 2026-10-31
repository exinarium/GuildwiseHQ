import {
  type BumpLevel,
  type ComponentBump,
  componentLine,
  composeReleaseSection,
  type DeskItemDto,
  releaseIntro,
  validateReleaseVersion,
} from '@aom/shared';
import { useMemo, useRef, useState } from 'react';
import { useResolveDeskItem } from '../api/queries/desk.ts';
import { usePrepareRelease } from '../api/queries/forges.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { Button, ErrorBox, TextArea, TextInput } from './ui.tsx';

const LEVELS: BumpLevel[] = ['patch', 'minor', 'major'];

/** How old a read of the repository is, in plain words. */
function age(at: string | null): string {
  if (!at) return 'not read yet';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return min < 1 ? 'read just now' : min < 60 ? `read ${min} min ago` : `read ${Math.round(min / 60)} h ago`;
}

/**
 * "Ship release": the recommended version with its reason, the changelog as it will read, and the component bumps. The
 * owner can type another version (refused inline, never as a toast) or raise a component. Approving prepares the release commit;
 * nothing is pushed, tagged or published by this step.
 */
export function ShipReleaseItem({ item }: { item: DeskItemDto }) {
  const rel = item.release;
  const resolve = useResolveDeskItem();
  const prepare = usePrepareRelease(rel?.projectId ?? '');
  const mobile = useIsMobile();
  const [version, setVersion] = useState(rel?.recommended.version ?? '');
  const [levels, setLevels] = useState<Record<string, BumpLevel>>({});
  const [notes, setNotes] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const check = useMemo(
    () => validateReleaseVersion(version, rel?.lastTag ?? null, rel?.existingTags ?? []),
    [version, rel?.lastTag, rel?.existingTags],
  );
  const bumps: ComponentBump[] = useMemo(
    () =>
      (rel?.componentVariants.patch ?? []).map(
        (_, i) =>
          rel?.componentVariants[levels[rel.componentVariants.patch[i]?.name ?? ''] ?? 'patch'][
            i
          ] as ComponentBump,
      ),
    [rel, levels],
  );
  if (!rel)
    return <p className="mt-3 text-sm text-subtle">This release proposal is not available any more.</p>;

  const intro = releaseIntro(rel.changelog?.intro ?? '', bumps);
  const fromChangelog = rel.changelog !== null && !rel.changelog.empty;
  const noteText = notes ?? rel.notes;
  const preview = fromChangelog
    ? composeReleaseSection(
        check.ok ? check.version : version.trim() || '?',
        rel.today,
        intro,
        rel.changelog?.body ?? '',
      )
    : composeReleaseSection(check.ok ? check.version : version.trim() || '?', rel.today, '', noteText);
  const shown = version.trim() === '' ? undefined : check.ok ? undefined : check.message;
  const serverMsg = resolve.error instanceof Error ? resolve.error.message : undefined;
  const reading = rel.factsState === 'pending';

  const approve = () =>
    resolve.mutate({
      id: item.id,
      body: {
        resolution: 'approved',
        release: {
          version: version.trim(),
          components: bumps.filter((b) => b.state === 'bump').map((b) => ({ name: b.name, level: b.level })),
          ...(rel.notesEditable ? { notes: noteText } : {}),
          factsHeadSha: rel.headSha,
        },
      },
    });

  return (
    <div className="mt-3 flex flex-col gap-4" data-testid="ship-release">
      <div className="flex flex-wrap items-center gap-2 text-sm text-subtle">
        <span>{rel.lastTag ? `Last release ${rel.lastTag}` : 'No release yet'}</span>
        <span aria-hidden="true">·</span>
        <span>{rel.ahead} commits ahead of the main branch</span>
        <span aria-hidden="true">·</span>
        <span>{reading ? 'reading the repository…' : age(rel.factsAt)}</span>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-0"
          loading={prepare.isPending}
          onClick={() => prepare.mutate(rel.repoId)}
        >
          Refresh
        </Button>
      </div>
      {rel.factsState === 'failed' && rel.factsMessage && (
        <p className="text-sm text-danger-soft-fg" role="alert">
          {rel.factsMessage}
        </p>
      )}
      {rel.commitsTruncated && <p className="text-xs text-subtle">Only the newest 1000 commits were read.</p>}

      <div>
        <TextInput
          ref={input}
          label="Version"
          value={version}
          error={shown ?? serverMsg}
          onChange={(e) => {
            resolve.reset();
            setVersion(e.target.value);
          }}
          onFocus={() => {
            if (mobile) input.current?.scrollIntoView({ block: 'center' });
          }}
          type="text"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className="min-h-11 font-mono"
          data-testid="ship-version"
        />
        <p className="mt-1 text-sm text-subtle" data-testid="ship-reason">
          {rel.recommended.reason}
        </p>
        {version.trim() !== rel.recommended.version && (
          <Button
            variant="link"
            className="mt-1 min-h-11 text-sm sm:min-h-0"
            onClick={() => {
              resolve.reset();
              setVersion(rel.recommended.version);
            }}
          >
            Use the recommended {rel.recommended.version}
          </Button>
        )}
      </div>

      <div data-testid="ship-components">
        <h4 className="text-sm font-medium text-fg">Component versions</h4>
        {bumps.length === 0 ? (
          <p className="text-sm text-subtle">This repository has no component version rules.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {bumps.map((b) => (
              <li key={b.name} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <span className="break-words font-mono text-xs text-fg">{componentLine(b)}</span>
                {b.state === 'bump' && (
                  <label className="flex items-center gap-2 text-xs text-subtle">
                    Bump
                    <select
                      aria-label={`${b.name} bump level`}
                      className="min-h-11 rounded-control border border-control bg-surface px-2 text-sm text-fg sm:min-h-8"
                      value={b.level}
                      onChange={(e) => setLevels((l) => ({ ...l, [b.name]: e.target.value as BumpLevel }))}
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-sm font-medium text-fg">Changelog preview</h4>
        {rel.changelog?.empty && (
          <p className="text-xs text-subtle">
            The Unreleased section is empty; the recommendation uses the commits.
          </p>
        )}
        {rel.changelog === null && (
          <p className="text-xs text-subtle">
            This repository has no CHANGELOG.md; the notes come from the commit titles.
          </p>
        )}
        {rel.notesEditable ? (
          <TextArea
            label="Release notes"
            value={noteText}
            onChange={(e) => setNotes(e.target.value)}
            rows={6}
            className="font-mono text-xs"
            data-testid="ship-notes"
          />
        ) : null}
        <pre
          className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-sunken p-3 font-mono text-xs"
          data-testid="ship-preview"
        >
          {preview}
        </pre>
      </div>

      <p className="text-xs text-subtle">
        Approving prepares the release commit (changelog and component versions) and pushes it to the working branch. Nothing is tagged or published yet.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap [&>button]:max-sm:w-full">
        <Button
          variant="primary"
          className="min-h-11 sm:min-h-0"
          disabled={!check.ok || reading}
          loading={resolve.isPending}
          onClick={approve}
        >
          Approve release {check.ok ? check.version : ''}
        </Button>
        <Button
          className="min-h-11 sm:min-h-0"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ id: item.id, body: { resolution: 'rejected' } })}
        >
          Reject
        </Button>
      </div>
      {!serverMsg && <ErrorBox error={prepare.error} />}
    </div>
  );
}
