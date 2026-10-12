import { useState } from 'react';
import { Link } from 'react-router';
import { useAgents } from '../../api/queries/agents.ts';
import { useCreateChat } from '../../api/queries/chats.ts';
import { ChatPanel } from '../ChatPanel.tsx';
import { Button, ErrorBox, Select } from '../ui.tsx';

/**
 * "Ask the BA": a chat beside the builder about the current draft. The first message carries an outline of the draft
 * (and its draft id once saved); "Tell the BA about my changes" sends the outline again after you edited.
 */
export function BuilderChat({ outline, disabled }: { outline: () => string; disabled?: boolean }) {
  const agents = useAgents();
  const create = useCreateChat();
  const [thread, setThread] = useState<{ id: string; opening: string; n: number } | null>(null);
  const [agentId, setAgentId] = useState('');
  const bas = (agents.data ?? []).filter(
    (a) => a.roleKey === 'ba' && a.status === 'active' && a.allowedProjectIds === null,
  );
  const chosen = agentId || bas[0]?.id || '';
  const intro = (text: string) =>
    `${text}\n\nPlease look at it with me: tell me what is unclear or missing, and answer my questions about it. Do not replace it unless I ask.`;

  return (
    <section aria-labelledby="ba-chat-title" className="flex flex-col gap-2" data-testid="builder-chat">
      <h2 id="ba-chat-title" className="text-base font-semibold">
        Ask the BA
      </h2>
      {agents.isPending ? null : bas.length === 0 ? (
        <p className="text-sm text-subtle" data-testid="builder-no-ba">
          Hire a business analyst on the{' '}
          <Link to="/agents?hire=ba" className="underline">
            HR board
          </Link>{' '}
          to talk this draft through.
        </p>
      ) : !thread ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-subtle">
            The BA reads an outline of this draft and can answer questions or suggest changes. You stay in
            control: nothing changes until you do it here.
          </p>
          {bas.length > 1 && (
            <Select label="Business analyst" value={chosen} onChange={(e) => setAgentId(e.target.value)}>
              {bas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
          <div>
            <Button
              disabled={create.isPending || !chosen || disabled}
              onClick={() =>
                create.mutate(
                  { agentId: chosen },
                  { onSuccess: (c) => setThread({ id: c.threadId, opening: intro(outline()), n: 0 }) },
                )
              }
            >
              Start a chat about this draft
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex h-[50dvh] min-h-72 flex-col" data-testid="builder-chat-panel">
            <ChatPanel key={thread.n} threadId={thread.id} initialMessage={thread.opening} />
          </div>
          <div>
            <Button
              size="sm"
              onClick={() =>
                setThread((t) =>
                  t
                    ? {
                        ...t,
                        n: t.n + 1,
                        opening: intro(`I changed the draft. Here it is now.\n${outline()}`),
                      }
                    : t,
                )
              }
            >
              Tell the BA about my changes
            </Button>
          </div>
        </div>
      )}
      <ErrorBox error={create.error} />
    </section>
  );
}
