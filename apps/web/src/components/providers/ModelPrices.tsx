import { DIRECT_PROVIDERS, type DirectProviderId } from '@aom/shared';
import { useState } from 'react';
import { useMe } from '../../api/queries/auth.ts';
import {
  useOrgModelPrices,
  useRemoveOrgModelPrice,
  useSetOrgModelPrice,
} from '../../api/queries/org-providers.ts';
import { Badge, Button, ErrorBox, Panel, TextInput, useToast } from '../ui.tsx';

const num = (s: string): number | null => {
  const n = Number(s.replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null;
};

/**
 * Prices the Owner sets for models the built-in list prices do not cover (a local Ollama model, a model released after this
 * version). Turns on such a model are costed with the price and marked owner-set; without one they show "cost unknown".
 * A model with a list price keeps it. Admins can read the list; only the Owner can change it.
 */
export function ModelPrices() {
  const me = useMe();
  const isOwner = me.data?.activeOrg?.role === 'owner';
  const list = useOrgModelPrices();
  const set = useSetOrgModelPrice();
  const remove = useRemoveOrgModelPrice();
  const toast = useToast();
  const [provider, setProvider] = useState<DirectProviderId>('openai-compatible');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cacheRead, setCacheRead] = useState('');
  const inP = num(input);
  const outP = num(output);
  const crP = cacheRead.trim() === '' ? null : num(cacheRead);
  const bad = !model.trim() || inP === null || outP === null || (cacheRead.trim() !== '' && crP === null);
  const save = () =>
    set.mutate(
      {
        provider,
        model: model.trim(),
        inputPerMtok: inP as number,
        outputPerMtok: outP as number,
        cacheReadPerMtok: crP,
      },
      {
        onSuccess: () => {
          setModel('');
          setInput('');
          setOutput('');
          setCacheRead('');
          toast.success('Price saved');
        },
      },
    );
  return (
    <Panel title="Prices for other models" data-testid="model-prices">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">
          Models without a list price (a local Ollama model, a brand-new release) show &quot;cost
          unknown&quot;. Enter what they cost you, in US dollars per million tokens, and their turns are
          costed with it and marked as owner-set. A model that has a list price keeps it. A new price applies
          to later turns only.
        </p>
        <ErrorBox error={list.error ?? set.error ?? remove.error} onRetry={() => list.refetch()} />
        {(list.data?.prices ?? []).length === 0 ? (
          <p className="text-subtle" data-testid="model-prices-empty">
            No owner-set prices.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {(list.data?.prices ?? []).map((p) => (
              <li
                key={`${p.provider}:${p.model}`}
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid={`model-price-${p.provider}-${p.model}`}
              >
                <span>
                  <span className="font-medium text-fg">{p.model}</span>{' '}
                  <span className="text-subtle">({p.provider})</span>: ${p.inputPerMtok} in / $
                  {p.outputPerMtok} out
                  {p.cacheReadPerMtok !== null ? ` / $${p.cacheReadPerMtok} cached` : ''} per million tokens{' '}
                  <Badge tone="neutral">Owner-set</Badge>
                </span>
                {isOwner && (
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => remove.mutate({ provider: p.provider, model: p.model })}
                    data-testid={`model-price-remove-${p.provider}-${p.model}`}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {isOwner ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Provider
              <select
                className="rounded-control border border-line bg-canvas px-2 py-1.5 text-sm text-fg"
                value={provider}
                data-testid="model-price-provider"
                onChange={(e) => setProvider(e.target.value as DirectProviderId)}
              >
                {DIRECT_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <TextInput
              label="Model id"
              value={model}
              data-testid="model-price-model"
              onChange={(e) => setModel(e.target.value)}
            />
            <TextInput
              label="Input $/Mtok"
              value={input}
              inputMode="decimal"
              data-testid="model-price-input"
              onChange={(e) => setInput(e.target.value)}
            />
            <TextInput
              label="Output $/Mtok"
              value={output}
              inputMode="decimal"
              data-testid="model-price-output"
              onChange={(e) => setOutput(e.target.value)}
            />
            <TextInput
              label="Cached input $/Mtok (optional)"
              value={cacheRead}
              inputMode="decimal"
              data-testid="model-price-cache"
              onChange={(e) => setCacheRead(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              loading={set.isPending}
              disabled={bad}
              data-testid="model-price-save"
              onClick={save}
            >
              Save price
            </Button>
          </div>
        ) : (
          <p className="text-subtle">Only the Owner can change prices.</p>
        )}
      </div>
    </Panel>
  );
}
