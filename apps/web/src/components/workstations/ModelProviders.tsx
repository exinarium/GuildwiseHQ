import {
  DIRECT_PROVIDERS,
  DIRECT_RUNTIME,
  type DirectProviderDef,
  type ReportedProvider,
  type WorkstationDto,
} from '@aom/shared';
import { useState } from 'react';
import { useRemoveProviderKey, useSetProviderKey } from '../../api/queries/providers.ts';
import { Badge, Button, Callout, ErrorBox, TextInput, useToast } from '../ui.tsx';

/** Does this workstation's runner have the direct API adapter? Older runners do not report the runtime at all. */
export const supportsDirect = (runtimes: WorkstationDto['runtimes']): boolean =>
  runtimes.some((r) => r.id === DIRECT_RUNTIME);

export const providersOf = (runtimes: WorkstationDto['runtimes']): ReportedProvider[] =>
  runtimes.find((r) => r.id === DIRECT_RUNTIME)?.providers ?? [];

const parseModels = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter(Boolean),
  ),
];

/**
 * Model providers of one workstation (docs/ARCHITECTURE.md section 38.3): the API keys for the direct API runtime. A key is
 * encrypted in the browser for this workstation's runner and kept only there; calls go from the workstation straight to the
 * provider. Card work (shell, edit) stays on Claude Code; these models talk in discovery, boardroom and chat.
 */
export function ModelProviders({ w, canEdit }: { w: WorkstationDto; canEdit: boolean }) {
  const supported = supportsDirect(w.runtimes);
  const reported = providersOf(w.runtimes);
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="model-providers">
      <p className="mb-1 text-xs font-medium text-subtle">Model providers (direct API)</p>
      {!supported ? (
        <p className="text-sm text-muted" data-testid="providers-update-runner">
          Update the runner to use direct API models (OpenAI, Gemini, Anthropic API and OpenAI-compatible
          endpoints).
        </p>
      ) : (
        <>
          <Callout tone="info">
            A key is encrypted in your browser for the runner of this workstation and kept only there. Calls
            go from this workstation straight to the provider; Guildwise never sees the key or the traffic.
            These models talk in Discovery, the Boardroom and chat. They have no shell or file tools, so card
            work stays on Claude Code.
          </Callout>
          <ul className="mt-2 flex flex-col gap-2">
            {DIRECT_PROVIDERS.map((def) => (
              <ProviderRow
                key={def.id}
                def={def}
                w={w}
                reported={reported.find((p) => p.id === def.id)}
                canEdit={canEdit}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProviderRow({
  def,
  w,
  reported,
  canEdit,
}: {
  def: DirectProviderDef;
  w: WorkstationDto;
  reported: ReportedProvider | undefined;
  canEdit: boolean;
}) {
  const set = useSetProviderKey(w.id);
  const remove = useRemoveProviderKey(w.id);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const offline = !w.connected;
  const baseProblem = def.needsBaseUrl && !/^https?:\/\/\S+$/.test(baseUrl.trim());
  const keyProblem = !def.keyOptional && !key;
  const disabled = offline || !canEdit;
  const save = () =>
    set.mutate(
      {
        provider: def.id,
        key,
        ...(def.needsBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
        models: parseModels(models),
      },
      {
        onSuccess: () => {
          setKey('');
          setOpen(false);
          toast.success(`${def.label} sent to ${w.name}`);
        },
      },
    );
  return (
    <li
      className="rounded-control border border-line bg-canvas p-3 text-sm"
      data-testid={`provider-${def.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-fg">{def.label}</span>
        {reported ? (
          <Badge tone={reported.problem ? 'neutral' : 'green'}>
            {reported.problem ? 'Problem' : 'Configured'}
          </Badge>
        ) : (
          <Badge tone="neutral">Not configured</Badge>
        )}
      </div>
      {reported && (
        <p className="mt-1 text-xs text-muted" data-testid={`provider-models-${def.id}`}>
          {reported.endpointHost ? `${reported.endpointHost}: ` : ''}
          {reported.models.length ? reported.models.map((m) => m.label).join(', ') : 'No models listed'}
        </p>
      )}
      {reported?.problem && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {reported.problem}
        </p>
      )}
      <p className="mt-1 text-xs text-subtle">{def.dataNote}</p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
            data-testid={`provider-edit-${def.id}`}
          >
            {reported ? 'Replace key' : 'Add key'}
          </Button>
          {reported && (
            <Button
              size="sm"
              variant="danger-ghost"
              disabled={offline}
              loading={remove.isPending}
              data-testid={`provider-remove-${def.id}`}
              onClick={() =>
                remove.mutate(def.id, {
                  onSuccess: () => toast.success(`${def.label} removed from ${w.name}`),
                })
              }
            >
              Remove
            </Button>
          )}
          {offline && <span className="self-center text-xs text-subtle">The workstation is offline.</span>}
        </div>
      )}
      {open && !disabled && (
        <div className="mt-2 flex flex-col gap-2">
          {def.needsBaseUrl && (
            <TextInput
              label="Base URL"
              hint={def.baseUrlHint}
              value={baseUrl}
              autoComplete="off"
              data-testid={`provider-url-${def.id}`}
              onChange={(e) => setBaseUrl(e.target.value)}
              error={
                baseUrl && baseProblem ? 'Enter a full URL starting with http:// or https://' : undefined
              }
            />
          )}
          <TextInput
            label={def.keyLabel}
            type="password"
            autoComplete="off"
            value={key}
            data-testid={`provider-key-${def.id}`}
            onChange={(e) => setKey(e.target.value)}
          />
          <TextInput
            label="Extra model ids (optional, comma separated)"
            value={models}
            autoComplete="off"
            data-testid={`provider-models-input-${def.id}`}
            onChange={(e) => setModels(e.target.value)}
          />
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={set.isPending}
              disabled={keyProblem || baseProblem}
              data-testid={`provider-save-${def.id}`}
              onClick={save}
            >
              Save
            </Button>
          </div>
        </div>
      )}
      <ErrorBox error={set.error ?? remove.error} />
    </li>
  );
}
