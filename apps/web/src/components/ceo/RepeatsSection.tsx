import type { CeoRepeatDto } from '@aom/shared';
import { useNavigate } from 'react-router';
import { useCeoChat } from '../../api/queries/ceo.ts';
import { useResolveRepeat } from '../../api/queries/ceo-chat.ts';
import { openCeoChat } from '../../lib/openCeoChat.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Button, ErrorBox } from '../ui.tsx';

type Decision = 'feature' | 'skill' | 'automation';

/** The text that opens the CEO chat for each button (docs/design/ceo-front-door.md section 4.3). */
export function repeatPrefill(r: CeoRepeatDto, decision: Decision): string {
  const title = r.jobs[0]?.title ?? r.key;
  if (decision === 'feature')
    return `turn this into a card for ${r.projectKey ?? 'the right project'}: ${title} (I keep asking for "${r.key}")`;
  if (decision === 'skill')
    return `draft a Claude Code skill for this in ~/.claude/skills: ${title} (I keep asking for "${r.key}")`;
  return `propose a schedule to automate: ${title} (I keep asking for "${r.key}")`;
}

/** "Things you keep asking me": repeated off-board jobs, each with what to make of it. Owner only. */
export function RepeatsSection({ repeats, owner }: { repeats: CeoRepeatDto[]; owner: boolean }) {
  const resolve = useResolveRepeat();
  const chat = useCeoChat();
  const nav = useNavigate();
  if (repeats.length === 0) return null;
  const go = (r: CeoRepeatDto, decision: Decision) =>
    chat.mutate(undefined, {
      onSuccess: (c) => {
        openCeoChat(nav, c.threadId, { prefill: repeatPrefill(r, decision) });
        resolve.mutate({ id: r.id, decision });
      },
    });
  return (
    <div data-testid="ceo-repeats">
      <h3 className="text-sm font-semibold text-fg">Things you keep asking me</h3>
      <ul className="mt-1 divide-y divide-line">
        {repeats.map((r) => (
          <li key={r.id} className="py-2 text-sm" data-testid="ceo-repeat">
            <p className="font-medium text-fg">
              {r.key}{' '}
              <span className="font-normal text-muted">
                ({r.count7} in 7 days, {r.count30} in 30)
              </span>
            </p>
            <ul className="mt-0.5 list-disc pl-5 text-xs text-muted">
              {r.jobs.slice(0, 5).map((j) => (
                <li key={j.id}>
                  {j.title} <span className="text-subtle">{formatDateTime(j.at)}</span>
                </li>
              ))}
            </ul>
            {owner && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => go(r, 'feature')}>
                  Make it a feature
                </Button>
                <Button size="sm" onClick={() => go(r, 'skill')}>
                  Make it a skill
                </Button>
                <Button size="sm" onClick={() => go(r, 'automation')}>
                  Automate it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={resolve.isPending}
                  onClick={() => resolve.mutate({ id: r.id, decision: 'dismissed' })}
                >
                  Not a pattern
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox error={resolve.error ?? chat.error} />
    </div>
  );
}
