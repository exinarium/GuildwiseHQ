import { DeliverySetupSchema, type SetupStateDto } from '@aom/shared';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePreviewSetup, usePublishSetup, useSaveSetupDraft } from '../../../api/queries/deploy-setup.ts';
import { Badge, Button, Callout, Disclosure, ErrorBox, TextArea, TextInput } from '../../ui.tsx';
import { FoundChanges } from './FoundChanges.tsx';

const PLACEHOLDER = { version: 1, generator: 'setup-1.0', environments: [] };

/**
 * The developer view of the same setup (design J7): the structured fields as JSON and as a few fields per environment, the
 * generated files read-only, the probe reports, and "Edit the script by hand" (the environment is then marked `custom`: the
 * compiler leaves its script alone) with "Back to guided" (regenerates it; needs a new approval).
 */
export function AdvancedSetup({
  projectId,
  state,
  onClose,
}: {
  projectId: string;
  state: SetupStateDto;
  onClose: () => void;
}) {
  const initial = (state.draft?.setup as object | null) ?? state.current.setup ?? PLACEHOLDER;
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [scripts, setScripts] = useState<Record<string, string>>(state.draft?.customScripts ?? {});
  const preview = usePreviewSetup(projectId);
  const publish = usePublishSetup(projectId);
  const draft = useSaveSetupDraft(projectId);
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as { environments?: Array<Record<string, any>> } };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : 'not valid JSON' };
    }
  }, [text]);
  const valid = parsed.ok ? DeliverySetupSchema.safeParse(parsed.value) : null;
  const envs = parsed.ok ? (parsed.value.environments ?? []) : [];
  const update = (fn: (envs: Array<Record<string, any>>) => void) => {
    if (!parsed.ok) return;
    const copy = JSON.parse(text) as { environments: Array<Record<string, any>> };
    fn(copy.environments ?? []);
    setText(JSON.stringify(copy, null, 2));
  };
  const run = () => parsed.ok && preview.mutate({ setup: parsed.value, customScripts: scripts });
  const fileOf = (path: string) => preview.data?.files.find((f) => f.path === path)?.content;

  return (
    <div className="flex flex-col gap-4" data-testid="advanced-setup">
      <div>
        <button
          type="button"
          onClick={onClose}
          className="mb-1 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to the simple view
        </button>
        <h2 className="text-lg font-semibold text-fg">Technical details</h2>
        <p className="text-sm text-muted">
          The same setup as the guided view, as the structured fields. Guildwise generates{' '}
          <code>recipe.yaml</code> and one script per environment from it. Editing a script by hand marks that
          environment "custom".
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">setup.json</h3>
        <TextArea
          label="setup.json"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          className="font-mono text-xs"
          data-testid="advanced-json"
          spellCheck={false}
        />
        {!parsed.ok && (
          <p className="text-sm text-danger" role="alert">
            {parsed.error}
          </p>
        )}
        {parsed.ok && valid && !valid.success && (
          <ul className="list-disc pl-5 text-sm text-danger" data-testid="advanced-errors">
            {valid.error.issues.slice(0, 6).map((i) => (
              <li key={`${i.path.join('.')}-${i.message}`}>
                {i.path.join('.') || 'setup'}: {i.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {envs.map((e, i) => (
        <section
          key={String(e.name)}
          className="flex flex-col gap-2 rounded-control border border-line p-3"
          data-testid={`advanced-env-${e.name}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-fg">{String(e.label ?? e.name)}</h3>
            <Badge tone={e.mode === 'custom' ? 'amber' : 'neutral'}>
              {e.mode === 'custom' ? 'custom (script by hand)' : 'guided'}
            </Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <TextInput
              label="Compose file"
              value={e.app?.composeFile ?? ''}
              onChange={(ev) =>
                update((a) => {
                  (a[i] as any).app.composeFile = ev.target.value;
                })
              }
            />
            <TextInput
              label="App service"
              value={e.app?.service ?? ''}
              onChange={(ev) =>
                update((a) => {
                  (a[i] as any).app.service = ev.target.value;
                })
              }
            />
            <TextInput
              label="Image name"
              value={e.app?.imageName ?? ''}
              onChange={(ev) =>
                update((a) => {
                  (a[i] as any).app.imageName = ev.target.value;
                })
              }
            />
            <TextInput
              label="Health address"
              value={e.health?.url ?? ''}
              onChange={(ev) =>
                update((a) => {
                  (a[i] as any).health = { kind: 'http', url: ev.target.value, expect: '2xx' };
                })
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {e.mode === 'custom' ? (
              <Button
                size="sm"
                data-testid={`back-to-guided-${e.name}`}
                onClick={() => {
                  update((a) => {
                    (a[i] as any).mode = 'guided';
                  });
                  setScripts((s) => {
                    const { [String(e.name)]: _x, ...rest } = s;
                    return rest;
                  });
                }}
              >
                Back to guided
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid={`edit-script-${e.name}`}
                onClick={() => {
                  update((a) => {
                    (a[i] as any).mode = 'custom';
                  });
                  setScripts((s) => ({
                    ...s,
                    [String(e.name)]:
                      fileOf(`scripts/${e.name}.sh`) ??
                      s[String(e.name)] ??
                      '#!/usr/bin/env bash\nset -euo pipefail\n',
                  }));
                  if (!preview.data) run();
                }}
              >
                Edit the script by hand
              </Button>
            )}
          </div>
          {e.mode === 'custom' && (
            <TextArea
              label={`scripts/${e.name}.sh`}
              rows={12}
              className="font-mono text-xs"
              value={scripts[String(e.name)] ?? ''}
              onChange={(ev) => setScripts((s) => ({ ...s, [String(e.name)]: ev.target.value }))}
              data-testid={`script-${e.name}`}
              spellCheck={false}
            />
          )}
        </section>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={run}
          loading={preview.isPending}
          disabled={!parsed.ok || !valid?.success}
          data-testid="advanced-preview"
        >
          Preview
        </Button>
        <Button
          onClick={() => parsed.ok && draft.mutate({ setup: parsed.value, customScripts: scripts })}
          loading={draft.isPending}
          disabled={!parsed.ok}
        >
          Save as draft
        </Button>
      </div>
      <ErrorBox error={preview.error ?? draft.error} />
      {preview.data && !preview.data.ok && (
        <Callout tone="danger" title="This cannot be saved yet" data-testid="advanced-issues">
          <ul className="list-disc pl-4">
            {preview.data.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Callout>
      )}
      {preview.data?.ok && (
        <section className="flex flex-col gap-3" data-testid="advanced-preview-result">
          <h3 className="text-sm font-semibold text-fg">
            Generated files{' '}
            <span className="font-mono text-xs font-normal text-subtle">
              {preview.data.hash?.slice(0, 12)}
            </span>
          </h3>
          {preview.data.files.map((f) => (
            <Disclosure
              key={f.path}
              summary={
                <span className="font-mono text-xs">
                  {f.mode === '755' ? 'x ' : ''}
                  {f.path}
                </span>
              }
            >
              <pre className="max-h-80 overflow-auto rounded-control bg-sunken p-2 font-mono text-xs">
                {f.content}
              </pre>
            </Disclosure>
          ))}
          {preview.data.keep.length > 0 && (
            <p className="text-xs text-subtle">Kept as they are: {preview.data.keep.join(', ')}</p>
          )}
          {preview.data.lint.length > 0 && (
            <ul className="text-sm">
              {preview.data.lint.map((l) => (
                <li key={l.message} className={l.level === 'error' ? 'text-danger' : 'text-warning'}>
                  {l.level === 'error' ? 'Must fix: ' : 'Note: '}
                  {l.message}
                </li>
              ))}
            </ul>
          )}
          <FoundChanges items={preview.data.changes} showEnv />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={publish.isPending}
              disabled={preview.data.lint.some((l) => l.level === 'error') || !parsed.ok}
              onClick={() =>
                parsed.ok &&
                preview.data?.hash &&
                publish.mutate({ setup: parsed.value, customScripts: scripts, setupHash: preview.data.hash })
              }
              data-testid="advanced-save"
            >
              Save
            </Button>
            {publish.isSuccess && (
              <span className="self-center text-sm text-muted">
                Sent to the computer. The Owner approves the version it writes.
              </span>
            )}
          </div>
          <ErrorBox error={publish.error} />
        </section>
      )}

      <Disclosure summary="What the computers found (probe reports)">
        {state.probes.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been looked at yet.</p>
        ) : (
          state.probes.map((p) => (
            <details key={p.id} className="mb-2">
              <summary className="cursor-pointer text-sm">
                {p.scope}
                {p.host ? ` ${p.host}` : ''} on {p.workstationName}, {new Date(p.at).toLocaleString()}
                {p.errorText ? `: ${p.errorText}` : ''}
              </summary>
              <pre className="max-h-64 overflow-auto rounded-control bg-sunken p-2 font-mono text-xs">
                {JSON.stringify(p.report ?? { error: p.error }, null, 2)}
              </pre>
            </details>
          ))
        )}
      </Disclosure>
    </div>
  );
}
