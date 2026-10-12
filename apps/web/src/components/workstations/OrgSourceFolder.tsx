import type { WorkstationDto } from '@aom/shared';
import { useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import { useSetOrgFolder } from '../../api/queries/workstations.ts';
import { Badge, Button, ErrorBox, Select, TextInput } from '../ui.tsx';

/**
 * "Organisation source folder": the folder on this workstation whose repositories the architect of the current
 * organisation may read (read-only, secrets blocked). Shown to the workstation's owner only. The runner decides whether
 * a path is acceptable (the same check as `aom-runner org-folder set`); this row shows what it reports back.
 */
export function OrgSourceFolder({ w }: { w: WorkstationDto }) {
  const me = useMe();
  const set = useSetOrgFolder();
  const [path, setPath] = useState('');
  const org = me.data?.activeOrg;
  const mine = !!me.data && w.userId === me.data.user.id;
  if (!mine || !org || !w.orgFolders) return null;
  const state = w.orgFolders.folders.find((f) => f.orgId.toLowerCase() === org.id.toLowerCase());
  const refusal = w.orgFolders.errors[org.id.toLowerCase()];
  const reported = !!w.orgFolders.checkedAt;
  const submit = (value: string | null) => set.mutate({ workstationId: w.id, orgId: org.id, path: value });
  const candidates = w.orgFolders.candidates.filter((c) => c !== state?.folder);
  return (
    <div className="mt-4 border-t border-line pt-3 text-sm" data-testid="org-folder">
      <p className="mb-1 text-xs font-medium text-subtle">Organisation source folder ({org.name})</p>
      <p className="mb-2 text-muted">
        The architect may read every repository in this folder, read-only; secret files stay blocked.
      </p>
      {!reported && (
        <p className="mb-2 text-subtle" data-testid="org-folder-unreported">
          Not reported yet (needs a current runner).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2" data-testid="org-folder-current">
        {state ? (
          <>
            <span className="font-mono text-xs break-all text-fg" data-testid="org-folder-path">
              {state.folder}
            </span>
            <Badge tone="neutral" data-testid="org-folder-repos">
              {state.repoCount} {state.repoCount === 1 ? 'repository' : 'repositories'}
            </Badge>
            {state.valid ? (
              <Badge tone="green" data-testid="org-folder-status">
                ok
              </Badge>
            ) : (
              <Badge tone="red" data-testid="org-folder-status">
                invalid
              </Badge>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={set.isPending}
              aria-label={`Clear the organisation source folder of ${w.name}`}
              onClick={() => submit(null)}
            >
              Clear
            </Button>
          </>
        ) : (
          <span className="text-subtle" data-testid="org-folder-path">
            not set
          </span>
        )}
      </div>
      {state && !state.valid && state.reason && (
        <p role="alert" className="mt-1 text-xs text-danger" data-testid="org-folder-reason">
          {state.reason}
        </p>
      )}
      {refusal && (
        <p role="alert" className="mt-1 text-xs text-danger" data-testid="org-folder-refused">
          The workstation refused that folder: {refusal}
        </p>
      )}
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) submit(path.trim());
        }}
      >
        {candidates.length > 0 && (
          <Select
            label="Folders on this workstation"
            value=""
            data-testid="org-folder-candidates"
            onChange={(e) => e.target.value && setPath(e.target.value)}
          >
            <option value="">Choose a folder…</option>
            {candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
        <TextInput
          label="Folder path"
          hint="A folder inside one of the runner's repository folders (not the folder itself). The workstation checks it."
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/home/me/src/acme"
          data-testid="org-folder-input"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={!path.trim() || set.isPending}>
            Set folder
          </Button>
          {!w.connected && (
            <span className="text-xs text-subtle">
              The workstation is offline: it applies this when it is back.
            </span>
          )}
        </div>
      </form>
      <ErrorBox error={set.error} />
    </div>
  );
}
