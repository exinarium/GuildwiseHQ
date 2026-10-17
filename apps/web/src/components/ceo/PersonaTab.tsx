import type { CeoSettings } from '@aom/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useCeoSettings, useSaveCeoSettings } from '../../api/queries/ceo.ts';
import { Button, Callout, ErrorBox, Panel, Select, Spinner, TextArea, TextInput, useToast } from '../ui.tsx';

const PURPOSES: Array<{ id: keyof CeoSettings['models']; label: string; hint: string }> = [
  { id: 'wake', label: 'Wakes', hint: 'Routine handling of the desk and the floor.' },
  { id: 'review', label: 'Daily review', hint: 'The report and the training review.' },
  { id: 'chat', label: 'Chat', hint: 'When you talk to it.' },
  { id: 'handover', label: 'Handover', hint: 'When it hands work over to the team.' },
];

type Draft = Pick<CeoSettings, 'persona' | 'standingInstructions' | 'models'>;

export function PersonaTab({ owner }: { owner: boolean }) {
  const q = useCeoSettings();
  const save = useSaveCeoSettings();
  const toast = useToast();
  const [d, setD] = useState<Draft | null>(null);
  useEffect(() => {
    if (q.data)
      setD({
        persona: q.data.settings.persona,
        standingInstructions: q.data.settings.standingInstructions,
        models: q.data.settings.models,
      });
  }, [q.data]);
  if (q.isPending) return <Spinner label="Loading the settings" />;
  if (!q.data || !d) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const edit = owner && q.data.canEdit;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(d, { onSuccess: () => toast.success('Saved') });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Persona and instructions">
      {!edit && (
        <Callout tone="info" role="note">
          Only the Owner can change these settings.
        </Callout>
      )}
      <Panel title="Persona">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Tone"
            disabled={!edit}
            value={d.persona.tone}
            onChange={(e) => setD({ ...d, persona: { ...d.persona, tone: e.target.value as 'concise' } })}
          >
            <option value="concise">Concise</option>
            <option value="warm">Warm</option>
            <option value="formal">Formal</option>
          </Select>
          <TextInput
            label="Language"
            maxLength={40}
            disabled={!edit}
            value={d.persona.language}
            onChange={(e) => setD({ ...d, persona: { ...d.persona, language: e.target.value } })}
          />
          <TextInput
            label="Signature"
            maxLength={200}
            disabled={!edit}
            value={d.persona.signature}
            onChange={(e) => setD({ ...d, persona: { ...d.persona, signature: e.target.value } })}
            hint="Added to what it writes for you."
          />
        </div>
      </Panel>
      <Panel title="Standing instructions">
        <TextArea
          label="Instructions for the CEO"
          rows={6}
          maxLength={2000}
          disabled={!edit}
          value={d.standingInstructions}
          onChange={(e) => setD({ ...d, standingInstructions: e.target.value })}
          hint={`${d.standingInstructions.length} of 2000. Added to every brief as an instruction from you, the owner, so keep it to things you mean.`}
        />
      </Panel>
      <Panel title="Models">
        <div className="flex flex-col gap-3">
          {PURPOSES.map((p) => (
            <div key={p.id} className="grid items-end gap-3 sm:grid-cols-[1fr_10rem_10rem]">
              <div>
                <p className="text-sm font-medium text-fg">{p.label}</p>
                <p className="text-xs text-subtle">{p.hint}</p>
              </div>
              <Select
                label={`${p.label}: model`}
                disabled={!edit}
                value={d.models[p.id].model}
                onChange={(e) =>
                  setD({
                    ...d,
                    models: { ...d.models, [p.id]: { ...d.models[p.id], model: e.target.value } },
                  })
                }
              >
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </Select>
              <Select
                label={`${p.label}: effort`}
                disabled={!edit}
                value={d.models[p.id].effort}
                onChange={(e) =>
                  setD({
                    ...d,
                    models: { ...d.models, [p.id]: { ...d.models[p.id], effort: e.target.value } },
                  })
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </div>
          ))}
        </div>
      </Panel>
      <ErrorBox error={save.error} />
      {edit && (
        <div>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}
