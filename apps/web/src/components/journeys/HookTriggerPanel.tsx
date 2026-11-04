import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useCreateJourneyHook, useJourneyHooks, useRotateJourneyHook } from '../../api/queries/journeys.ts';
import { Badge, Button, Callout, Panel, Select, TextInput, useToast } from '../ui.tsx';

/** Inbound webhooks of a journey: a unique URL and shared secret per trigger. The secret is shown once. */
export function HookTriggerPanel({ journeyId, canEdit }: { journeyId: string; canEdit: boolean }) {
  const toast = useToast();
  const q = useJourneyHooks(journeyId);
  const create = useCreateJourneyHook(journeyId);
  const rotate = useRotateJourneyHook(journeyId);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<'start' | 'resume'>('start');
  const [externalId, setExternalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [shown, setShown] = useState<{ url: string; secret: string } | null>(null);
  const fail = (e: unknown) => toast.error(errorMessage(e));
  const ready = name.trim() !== '' && externalId.trim().startsWith('/');
  return (
    <Panel title="Webhooks" className="mt-6">
      <p className="mb-3 text-sm text-muted">
        An outside system can start this journey (or end a webhook wait) by calling a private address with a signed message. The
        message is read once to find the record; it is not stored.
      </p>
      {shown && (
        <Callout tone="warning" title="Copy these now: the secret is not shown again" className="mb-3" role="status">
          <p className="[overflow-wrap:anywhere]" data-testid="hook-url">Address: {shown.url}</p>
          <p className="[overflow-wrap:anywhere]" data-testid="hook-secret">Secret: {shown.secret}</p>
        </Callout>
      )}
      <ul className="mb-3 flex flex-col gap-2" data-testid="hook-list">
        {(q.data ?? []).map((h) => (
          <li key={h.id} className="rounded-control border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">{h.name}</span>
              <Badge tone="neutral">{h.purpose === 'start' ? 'Starts a journey' : 'Ends a wait'}</Badge>
              {!h.enabled && <Badge tone="warning">Off</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              Record id from {h.mapping.externalId}
              {h.recentCalls[0] ? ` · last call ${new Date(h.recentCalls[0].at).toLocaleString()}: ${h.recentCalls[0].outcome ?? h.recentCalls[0].status}` : ' · never called'}
            </p>
            {canEdit && h.enabled && (
              <Button
                className="mt-2"
                variant="secondary"
                size="sm"
                loading={rotate.isPending}
                onClick={() => rotate.mutate(h.id, { onSuccess: (r) => setShown(r), onError: fail })}
              >
                New secret
              </Button>
            )}
          </li>
        ))}
        {q.data?.length === 0 && <li className="text-sm text-muted">No webhooks yet.</li>}
      </ul>
      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Name" value={name} enterKeyHint="next" onChange={(e) => setName(e.target.value)} />
          <Select label="What it does" value={purpose} onChange={(e) => setPurpose(e.target.value as 'start' | 'resume')}>
            <option value="start">Starts a journey</option>
            <option value="resume">Ends a webhook wait</option>
          </Select>
          <TextInput
            label="Where the record id is in the message (for example /client/id)"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="next"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
          <TextInput
            label="Where the name is (optional)"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="done"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <div>
            <Button
              disabled={!ready}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  { name: name.trim(), purpose, mapping: { externalId: externalId.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) } },
                  {
                    onSuccess: (r) => {
                      setShown(r);
                      setName('');
                      setExternalId('');
                      setDisplayName('');
                    },
                    onError: fail,
                  },
                )
              }
            >
              Add a webhook
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
