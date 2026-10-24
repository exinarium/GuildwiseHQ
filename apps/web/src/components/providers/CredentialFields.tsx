import {
  type BackendDef,
  backendDef,
  DIRECT_PROVIDERS,
  type DirectProviderDef,
  directProvider,
  type ProviderKeyId,
  validateBackendFields,
} from '@aom/shared';
import { Callout, TextArea, TextInput } from '../ui.tsx';

/** What the form for one provider key asks for and how its values become the sealed secret. */
export interface CredentialDraft {
  /** A direct-model provider's key, or the single secret value. */
  key: string;
  /** A Claude Code backend's fields (`backends.ts`). */
  fields: Record<string, string>;
  baseUrl: string;
  models: string;
}

export const emptyDraft = (): CredentialDraft => ({ key: '', fields: {}, baseUrl: '', models: '' });

export const parseModelIds = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter(Boolean),
  ),
];

export const isBackend = (id: ProviderKeyId): boolean => backendDef(id) !== undefined;

/** Why the draft cannot be sent yet (or null), in the words the form shows. */
export function draftProblem(id: ProviderKeyId, d: CredentialDraft): string | null {
  const be = backendDef(id);
  if (be) {
    const fields = { ...d.fields };
    return (
      validateBackendFields(be.id, fields) ??
      (be.id === 'gateway' && parseModelIds(d.models).length === 0
        ? 'Add at least one model id: a gateway serves what it is set up with'
        : null)
    );
  }
  const def = directProvider(id);
  if (!def) return 'Unknown provider';
  if (def.needsBaseUrl && !/^https?:\/\/\S+$/.test(d.baseUrl.trim()))
    return 'Enter a full URL starting with http:// or https://';
  if (!def.keyOptional && !d.key.trim()) return `Enter the ${def.keyLabel.toLowerCase()}`;
  return null;
}

/** The text that is sealed: the key itself, or the JSON of a backend's fields. */
export function secretOf(id: ProviderKeyId, d: CredentialDraft): string {
  if (isBackend(id))
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(d.fields)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v),
      ),
    );
  return d.key.trim();
}

/** A non-secret line for the page: region, project or endpoint host. */
export function detailOf(id: ProviderKeyId, d: CredentialDraft): string {
  const be = backendDef(id);
  if (be) {
    const f = d.fields;
    if (be.id === 'bedrock') return f.region?.trim() ?? '';
    if (be.id === 'vertex')
      return [f.projectId?.trim(), f.region?.trim() || 'global'].filter(Boolean).join(' / ');
    try {
      return new URL(f.baseUrl?.trim() ?? '').host;
    } catch {
      return '';
    }
  }
  try {
    return d.baseUrl.trim() ? new URL(d.baseUrl.trim()).host : '';
  } catch {
    return '';
  }
}

/**
 * The inputs for one provider's key or credential: one password field and an endpoint for a direct provider, the listed fields
 * for a Claude Code backend. The same form serves a workstation's own key and the organization's key. Nothing here sends anything.
 */
export function CredentialFields({
  id,
  draft,
  onChange,
  testPrefix,
}: {
  id: ProviderKeyId;
  draft: CredentialDraft;
  onChange: (d: CredentialDraft) => void;
  testPrefix: string;
}) {
  const be: BackendDef | undefined = backendDef(id);
  const def: DirectProviderDef | undefined = DIRECT_PROVIDERS.find((p) => p.id === id);
  if (be)
    return (
      <div className="flex flex-col gap-2">
        {be.warning && (
          <Callout tone="warning" data-testid={`${testPrefix}-warning-${id}`}>
            {be.warning}
          </Callout>
        )}
        {be.fields.map((f) =>
          f.multiline ? (
            <TextArea
              key={f.key}
              label={f.label}
              hint={f.hint}
              rows={5}
              autoComplete="off"
              spellCheck={false}
              value={draft.fields[f.key] ?? ''}
              data-testid={`${testPrefix}-field-${id}-${f.key}`}
              onChange={(e) => onChange({ ...draft, fields: { ...draft.fields, [f.key]: e.target.value } })}
            />
          ) : (
            <TextInput
              key={f.key}
              label={f.optional ? `${f.label} (optional)` : f.label}
              hint={f.hint}
              placeholder={f.placeholder}
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              value={draft.fields[f.key] ?? ''}
              data-testid={`${testPrefix}-field-${id}-${f.key}`}
              onChange={(e) => onChange({ ...draft, fields: { ...draft.fields, [f.key]: e.target.value } })}
            />
          ),
        )}
        <TextInput
          label={
            be.id === 'gateway'
              ? 'Model ids (comma separated)'
              : 'Extra model ids (optional, comma separated)'
          }
          hint={
            be.id === 'gateway'
              ? 'The model names your gateway serves, for example gemini/gemini-2.5-pro'
              : undefined
          }
          autoComplete="off"
          value={draft.models}
          data-testid={`${testPrefix}-models-${id}`}
          onChange={(e) => onChange({ ...draft, models: e.target.value })}
        />
      </div>
    );
  if (!def) return null;
  return (
    <div className="flex flex-col gap-2">
      {def.needsBaseUrl && (
        <TextInput
          label="Base URL"
          hint={def.baseUrlHint}
          value={draft.baseUrl}
          autoComplete="off"
          data-testid={`${testPrefix}-url-${id}`}
          onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          error={
            draft.baseUrl && !/^https?:\/\/\S+$/.test(draft.baseUrl.trim())
              ? 'Enter a full URL starting with http:// or https://'
              : undefined
          }
        />
      )}
      <TextInput
        label={def.keyLabel}
        type="password"
        autoComplete="off"
        value={draft.key}
        data-testid={`${testPrefix}-key-${id}`}
        onChange={(e) => onChange({ ...draft, key: e.target.value })}
      />
      <TextInput
        label="Extra model ids (optional, comma separated)"
        value={draft.models}
        autoComplete="off"
        data-testid={`${testPrefix}-models-${id}`}
        onChange={(e) => onChange({ ...draft, models: e.target.value })}
      />
    </div>
  );
}
