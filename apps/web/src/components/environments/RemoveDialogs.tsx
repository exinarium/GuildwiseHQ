import type { DeliverySetup, SetupEnv, SetupStateDto } from '@aom/shared';
import { useState } from 'react';
import { usePreviewSetup, usePublishSetup } from '../../api/queries/deploy-setup.ts';
import {
  useDiscardDraft,
  usePublishDraft,
  useRemoveEnvironment,
  useSetEnvironmentPlace,
  useStopGuided,
} from '../../api/queries/environments.ts';
import { Button, Callout, Dialog, ErrorBox, useToast } from '../ui.tsx';
import { Choice } from './Choice.tsx';
import { type PlaceVm, placeOfEnv, placesOf } from './model.ts';

/**
 * Remove an environment (docs/design/environments-ux.md journey F): the confirm names what happens and what does not. The app
 * that runs is left exactly as it is; Guildwise only stops updating it.
 */
export function RemoveEnvironmentDialog({
  projectId,
  label,
  env,
  place,
  last,
  onClose,
}: {
  projectId: string;
  label: string;
  env: SetupEnv;
  place: PlaceVm | undefined;
  /** It is the only environment: removing it means stopping guided deploys. */
  last: boolean;
  onClose: () => void;
}) {
  const remove = useRemoveEnvironment(projectId);
  const stop = useStopGuided(projectId);
  const publish = usePublishDraft(projectId);
  const toast = useToast();
  const where = place ? place.name : 'its place';
  const busy = remove.isPending || stop.isPending || publish.isPending;
  const go = async () => {
    try {
      if (last) await stop.mutateAsync();
      else {
        const r = await remove.mutateAsync(env.name);
        const saved = await publish.mutateAsync(r.draft?.setup);
        if (!saved.ok) return;
      }
      toast.success(`${label} removed. The app was not touched.`);
      onClose();
    } catch {
      // shown below
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Remove ${label}?`}
      footer={
        <>
          <Button variant="ghost" autoFocus onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} data-testid="remove-env-confirm" onClick={() => void go()}>
            Remove {label}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm text-muted" data-testid="remove-env-dialog">
        <p>
          Guildwise stops updating {label}. The app that is running on {where} is left exactly as it is.
        </p>
        {last && (
          <p data-testid="remove-last">
            This is the only environment, so Guildwise stops using guided deploys for this project. Your
            places and files stay.
          </p>
        )}
        <p>
          {place ? `${place.name} stays in your places` : 'The place stays'}, so you can add the environment
          again later. The setup changes, so the Owner approves it again.
        </p>
        {remove.data && remove.data.impact.length > 0 && (
          <ul className="list-disc pl-5" data-testid="remove-impact">
            {remove.data.impact.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {publish.data && !publish.data.ok && (
          <Callout tone="danger" title="The change cannot be saved yet">
            <ul className="list-disc pl-4">
              {publish.data.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </Callout>
        )}
        <ErrorBox error={remove.error ?? stop.error ?? publish.error} />
      </div>
    </Dialog>
  );
}

/** Change the place of an environment (journey E): point it at another place that is already connected. */
export function ChangePlaceDialog({
  projectId,
  s,
  env,
  label,
  onClose,
  onAddServer,
  onMove,
}: {
  projectId: string;
  s: SetupStateDto;
  env: SetupEnv;
  label: string;
  onClose: () => void;
  onAddServer: () => void;
  /** Open the move wizard (a server with its data). */
  onMove?: (() => void) | undefined;
}) {
  const places = placesOf(s);
  const current = placeOfEnv(places, env);
  const kind = env.hosting === 'ssh' ? 'server' : 'computer';
  const options = places.filter(
    (p) => p.role === 'active' && !p.duplicateOf && p.kind === kind && p.id !== current?.id,
  );
  const [pick, setPick] = useState('');
  const setPlace = useSetEnvironmentPlace(projectId);
  const publish = usePublishDraft(projectId);
  const toast = useToast();
  const chosen = options.find((p) => p.id === pick);
  const change = async () => {
    if (!chosen) return;
    try {
      const st = await setPlace.mutateAsync({ env: env.name, placeId: chosen.id });
      const saved = await publish.mutateAsync(st.draft?.setup);
      if (!saved.ok) return;
      toast.success(`${label} now uses ${chosen.name}. Try it and approve it again.`);
      onClose();
    } catch {
      // shown below
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Change the ${kind} of ${label}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!chosen}
            loading={setPlace.isPending || publish.isPending}
            onClick={() => void change()}
            data-testid="change-place-confirm"
          >
            Use {chosen?.name ?? `the ${kind}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="change-place-dialog">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-fg">
            Point {label} at another {kind} I already connected
          </legend>
          {options.map((p) => (
            <Choice
              key={p.id}
              name="change-place"
              checked={pick === p.id}
              onSelect={() => setPick(p.id)}
              title={p.name}
              testId={`change-place-${p.key}`}
            >
              {p.what}
            </Choice>
          ))}
          {options.length === 0 && (
            <p className="text-sm text-muted" data-testid="change-place-none">
              There is no other {kind} yet.
            </p>
          )}
          {kind === 'server' && (
            <div>
              <Button size="sm" onClick={onAddServer} data-testid="change-add-server">
                Add a server
              </Button>
            </div>
          )}
        </fieldset>
        <Callout tone="info">
          The steps are written for a place, so they are made again. They need trying and approving again
          before anything runs. The app on {current?.name ?? 'the old place'} is not touched.
        </Callout>
        {kind === 'server' && onMove && env.mode === 'guided' && (
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <p className="text-sm font-medium text-fg">
              Or move the live site to a new server, with its data
            </p>
            <p className="text-sm text-muted">
              Guildwise copies the app and the database to the new server, you check it, then you switch.
            </p>
            <div>
              <Button size="sm" onClick={onMove} data-testid="change-move">
                Move to a new server
              </Button>
            </div>
          </div>
        )}
        <ErrorBox error={setPlace.error ?? publish.error} />
        {publish.data && !publish.data.ok && (
          <Callout tone="danger" title="These steps cannot be saved yet">
            <ul className="list-disc pl-4">
              {publish.data.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

/**
 * "Unfinished changes and old files": the unfinished draft and the files in `delivery/` that Guildwise does not make. Each has
 * a checkbox; nothing is deleted unless it is ticked.
 */
export function CleanUpDialog({
  projectId,
  s,
  unmodelled,
  onClose,
}: {
  projectId: string;
  s: SetupStateDto;
  unmodelled: string[];
  onClose: () => void;
}) {
  const hasDraft = !!s.draft;
  const [dropDraft, setDropDraft] = useState(hasDraft);
  const [files, setFiles] = useState<string[]>([]);
  const discard = useDiscardDraft(projectId);
  const preview = usePreviewSetup(projectId);
  const publish = usePublishSetup(projectId);
  const toast = useToast();
  const busy = discard.isPending || preview.isPending || publish.isPending;
  const toggle = (f: string) => setFiles((c) => (c.includes(f) ? c.filter((x) => x !== f) : [...c, f]));
  const run = async () => {
    try {
      if (dropDraft && hasDraft) await discard.mutateAsync();
      if (files.length > 0 && s.current.setup) {
        const p = await preview.mutateAsync({ setup: s.current.setup, removeFiles: files });
        if (p.ok && p.hash)
          await publish.mutateAsync({ setup: s.current.setup, setupHash: p.hash, removeFiles: files });
      }
      toast.success('Cleaned up');
      onClose();
    } catch {
      // shown below
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Old setups and drafts"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!(dropDraft && hasDraft) && files.length === 0}
            onClick={() => void run()}
            data-testid="cleanup-confirm"
          >
            Clean up
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="cleanup-dialog">
        <p className="text-muted">
          Tick what you want gone. Your running apps are never touched; these are only Guildwise's own notes
          and files.
        </p>
        {hasDraft && (
          <label className="flex min-h-11 items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={dropDraft}
              onChange={(e) => setDropDraft(e.target.checked)}
              data-testid="cleanup-draft"
            />
            <span>
              <strong>Unfinished changes</strong>
              <span className="block text-muted">
                Saved as a draft. Nothing from it is in the project yet. Throw it away.
              </span>
            </span>
          </label>
        )}
        {unmodelled.length > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="font-medium text-fg">
              Files in the deploy folder that Guildwise does not make
            </legend>
            {unmodelled.map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={files.includes(f)}
                  onChange={() => toggle(f)}
                  data-testid={`cleanup-file-${f}`}
                />
                <span className="font-mono text-xs [overflow-wrap:anywhere]">{f}</span>
                <span className="text-xs text-subtle">{files.includes(f) ? 'will be deleted' : 'kept'}</span>
              </label>
            ))}
          </fieldset>
        )}
        {!hasDraft && unmodelled.length === 0 && <p className="text-muted">Nothing to clean up.</p>}
        <ErrorBox error={discard.error ?? preview.error ?? publish.error} />
      </div>
    </Dialog>
  );
}
