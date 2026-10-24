import {
  BACKENDS,
  type BackendDef,
  DIRECT_PROVIDERS,
  DIRECT_RUNTIME,
  type DirectProviderDef,
  type KeySource,
  parsePrivateEndpoint,
  type ReportedBackend,
  type ReportedProvider,
  type WorkstationDto,
} from '@aom/shared';
import { useState } from 'react';
import {
  useRemoveProviderKey,
  useSetPrivateEndpoints,
  useSetProviderKey,
} from '../../api/queries/providers.ts';
import { canSealHere } from '../../lib/secure.ts';
import {
  type CredentialDraft,
  CredentialFields,
  draftProblem,
  emptyDraft,
  parseModelIds,
  secretOf,
} from '../providers/CredentialFields.tsx';
import { SecureContextNotice } from '../SecureContextNotice.tsx';
import { Badge, Button, Callout, ErrorBox, TextInput, useToast } from '../ui.tsx';

/** Does this workstation's runner have the direct API adapter? Older runners do not report the runtime at all. */
export const supportsDirect = (runtimes: WorkstationDto['runtimes']): boolean =>
  runtimes.some((r) => r.id === DIRECT_RUNTIME);

export const providersOf = (runtimes: WorkstationDto['runtimes']): ReportedProvider[] =>
  runtimes.find((r) => r.id === DIRECT_RUNTIME)?.providers ?? [];

/** The Claude Code backends (Bedrock, Vertex, a gateway) that have a credential on this workstation. */
export const backendsOf = (runtimes: WorkstationDto['runtimes']): ReportedBackend[] =>
  runtimes.find((r) => r.id === 'claude-code')?.backends ?? [];

/** Does the runner keep organization keys and the Claude Code backends? Newer runners always report their `keys`, even none. */
export const supportsBackends = (runtimes: WorkstationDto['runtimes']): boolean =>
  runtimes.find((r) => r.id === DIRECT_RUNTIME)?.keys !== undefined;

/** An http:// endpoint that is not on this machine (the runner warns after saving too; this is the warning before). */
export function plainHttpAway(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (
      u.protocol === 'http:' &&
      !(/^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i.test(u.hostname) || u.hostname.endsWith('.localhost'))
    );
  } catch {
    return false;
  }
}

/** Whose key is in effect, in words: the workstation's own key overrides the organization's. */
export function KeySourceBadge({
  source,
  orgKey,
}: {
  source: KeySource | undefined;
  orgKey: boolean | undefined;
}) {
  if (source === 'org')
    return (
      <Badge
        tone="info"
        title="The organization's key, sent by an Owner or Admin. Runs on it count against the organization's monthly cap."
      >
        Organization key
      </Badge>
    );
  return (
    <Badge
      tone="neutral"
      title={
        orgKey
          ? 'This workstation has its own key; the organization also has one, which this key overrides. Runs on your own key are not capped.'
          : 'Your own key. Runs on it are not capped.'
      }
    >
      {orgKey ? 'Own key (overrides the organization’s)' : 'Own key'}
    </Badge>
  );
}

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
            These models talk in Discovery, the Boardroom and chat. They have no shell or file tools: for card
            work the same keys serve the Gemini CLI and opencode runtimes, and Claude Code can use Bedrock,
            Vertex AI or a gateway (below). An Owner or Admin can also share an organization-wide key with
            this workstation (Settings, Model providers); a key you add here overrides it and is not subject
            to the organization's monthly cap.
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
      {supported && <PrivateEndpoints w={w} canEdit={canEdit} />}
      {supported && <BackendsSection w={w} canEdit={canEdit} />}
    </div>
  );
}

/** The private-endpoint allow-list the runner last reported; undefined from a runner that does not know it. */
export const privateEndpointsOf = (runtimes: WorkstationDto['runtimes']): string[] | undefined =>
  runtimes.find((r) => r.id === DIRECT_RUNTIME)?.privateEndpoints;

/**
 * Private endpoints (R2): specific host:port entries on a private network (a LAN Ollama or LM Studio) that this workstation's
 * agents' sandboxes and its direct models may reach. Off by default; exact entries only; the workstation's owner edits it.
 */
function PrivateEndpoints({ w, canEdit }: { w: WorkstationDto; canEdit: boolean }) {
  const list = privateEndpointsOf(w.runtimes);
  const set = useSetPrivateEndpoints(w.id);
  const toast = useToast();
  const [text, setText] = useState('');
  const parsed = text.trim() ? parsePrivateEndpoint(text) : undefined;
  if (list === undefined) return null;
  const save = (next: string[], done?: () => void) =>
    set.mutate(next, {
      onSuccess: () => {
        toast.success('Saved. The workstation applies it in a moment.');
        done?.();
      },
    });
  return (
    <div className="mt-3" data-testid="private-endpoints">
      <p className="mb-1 text-xs font-medium text-subtle">Private endpoints (off by default)</p>
      <p className="text-sm text-muted">
        Agents on this workstation and its direct models can only reach the public internet and this computer.
        To let them reach a model server on your network (a LAN Ollama or LM Studio), list its exact address
        and port, for example <code>192.168.1.12:11434</code>. No wildcards or ranges; cloud metadata and
        link-local addresses can never be listed.
      </p>
      {list.length === 0 ? (
        <p className="mt-1 text-sm text-muted" data-testid="private-endpoints-empty">
          None listed.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1" aria-label="Private endpoints">
          {list.map((e) => (
            <li key={e} className="flex items-center gap-2 text-sm">
              <code>{e}</code>
              {canEdit && (
                <Button
                  size="sm"
                  variant="danger-ghost"
                  aria-label={`Remove ${e}`}
                  loading={set.isPending}
                  onClick={() =>
                    save(
                      list.filter((x) => x !== e),
                      undefined,
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <TextInput
            label="Add host:port"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="192.168.1.12:11434"
          />
          <Button
            variant="primary"
            disabled={!parsed?.ok}
            loading={set.isPending}
            onClick={() => parsed?.ok && save([...new Set([...list, parsed.entry])], () => setText(''))}
          >
            Add
          </Button>
        </div>
      )}
      {parsed && !parsed.ok && (
        <p className="mt-1 text-xs text-danger" role="alert" data-testid="private-endpoint-problem">
          {parsed.error}
        </p>
      )}
      <ErrorBox error={set.error} />
    </div>
  );
}

/** Claude Code against Amazon Bedrock, Google Vertex AI or an Anthropic-compatible gateway: same harness and sandbox, another backend. */
function BackendsSection({ w, canEdit }: { w: WorkstationDto; canEdit: boolean }) {
  if (!supportsBackends(w.runtimes))
    return (
      <p className="mt-3 text-xs text-muted" data-testid="backends-update-runner">
        Update the runner to use Claude Code with Amazon Bedrock, Google Vertex AI or a gateway.
      </p>
    );
  const reported = backendsOf(w.runtimes);
  return (
    <div className="mt-4" data-testid="claude-backends">
      <p className="mb-1 text-xs font-medium text-subtle">Claude Code on another backend</p>
      <p className="mb-2 text-xs text-muted">
        Agents keep Claude Code's tools and sandbox; only the model comes from your cloud account or gateway.
        Pick such a model when you hire an agent or change its model. The credentials are encrypted for this
        runner and put into that agent's process only.
      </p>
      <ul className="flex flex-col gap-2">
        {BACKENDS.map((def) => (
          <BackendRow
            key={def.id}
            def={def}
            w={w}
            reported={reported.find((b) => b.id === def.id)}
            canEdit={canEdit}
          />
        ))}
      </ul>
    </div>
  );
}

function BackendRow({
  def,
  w,
  reported,
  canEdit,
}: {
  def: BackendDef;
  w: WorkstationDto;
  reported: ReportedBackend | undefined;
  canEdit: boolean;
}) {
  const set = useSetProviderKey(w.id);
  const remove = useRemoveProviderKey(w.id);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CredentialDraft>(emptyDraft());
  const problem = draftProblem(def.id, draft);
  const offline = !w.connected;
  const save = () =>
    set.mutate(
      { provider: def.id, key: secretOf(def.id, draft), models: parseModelIds(draft.models) },
      {
        onSuccess: () => {
          setDraft(emptyDraft());
          setOpen(false);
          toast.success(`${def.label} sent to ${w.name}`);
        },
      },
    );
  return (
    <li
      className="rounded-control border border-line bg-canvas p-3 text-sm"
      data-testid={`backend-${def.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-fg">{def.label}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {reported && <KeySourceBadge source={reported.keySource} orgKey={reported.orgKey} />}
          <Badge tone={reported ? 'green' : 'neutral'}>{reported ? 'Configured' : 'Not configured'}</Badge>
        </span>
      </div>
      {reported && (
        <p className="mt-1 text-xs text-muted" data-testid={`backend-models-${def.id}`}>
          {reported.detail ? `${reported.detail}: ` : ''}
          {reported.models.length
            ? reported.models.map((m) => m.label).join(', ')
            : 'No models yet: add model ids'}
        </p>
      )}
      <p className="mt-1 text-xs text-subtle">{def.dataNote}</p>
      {def.warning && (
        <p className="mt-1 text-xs text-warning-soft-fg" data-testid={`backend-warning-${def.id}`}>
          {def.warning}
        </p>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={offline}
            onClick={() => setOpen((o) => !o)}
            data-testid={`backend-edit-${def.id}`}
          >
            {reported ? 'Replace credentials' : 'Add credentials'}
          </Button>
          {reported && (
            <Button
              size="sm"
              variant="danger-ghost"
              disabled={offline}
              loading={remove.isPending}
              data-testid={`backend-remove-${def.id}`}
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
      {open && !offline && canEdit && (
        <div className="mt-2 flex flex-col gap-2">
          <SecureContextNotice />
          <CredentialFields id={def.id} draft={draft} onChange={setDraft} testPrefix="backend" />
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={set.isPending}
              disabled={!!problem || !canSealHere()}
              title={problem ?? undefined}
              data-testid={`backend-save-${def.id}`}
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
        <span className="flex flex-wrap items-center gap-1.5">
          {reported && <KeySourceBadge source={reported.keySource} orgKey={reported.orgKey} />}
          {reported ? (
            <Badge tone={reported.problem ? 'neutral' : 'green'}>
              {reported.problem ? 'Problem' : 'Configured'}
            </Badge>
          ) : (
            <Badge tone="neutral">Not configured</Badge>
          )}
        </span>
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
          {key ? <SecureContextNotice /> : null}
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
          {baseUrl && plainHttpAway(baseUrl) && (
            <Callout tone="warning" data-testid="provider-http-warning">
              This endpoint uses plain http:// away from this machine: the key and every prompt travel
              unencrypted. Use https:// unless the network is trusted.
            </Callout>
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
              disabled={keyProblem || baseProblem || (!!key && !canSealHere())}
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
