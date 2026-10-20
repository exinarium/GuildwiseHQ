import { type CeoTopicDto, type CeoTopicsDto, TOPIC_AREAS } from '@aom/shared';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { checkTopic, useAcceptTopic, useCeoTopics, useRejectTopic } from '../../api/queries/ceo-topics.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';
import { FINDING_TEXT, type Finding } from '../blog/BlogTopicsPanel.tsx';
import { Button, Callout, ErrorBox, Select, TextArea } from '../ui.tsx';

/** Who may decide: the Owner in a customer organization (his consent), an Owner or Admin in the platform organization. */
export function useCanDecideTopics(topics: Pick<CeoTopicsDto, 'ownerOnly'> | undefined): boolean {
  const role = useActiveOrgRole();
  if (!topics) return false;
  return topics.ownerOnly ? role === 'owner' : role === 'owner' || role === 'admin';
}

const evidenceText = (t: CeoTopicDto) =>
  t.evidenceKinds.length ? `from ${t.evidenceKinds.join(', ')}` : 'from the conversation';

/** A proposed topic with its Accept / Edit / Reject (the same card in the report and on the Topics tab). */
export function ProposedTopic({ topic: t, canDecide }: { topic: CeoTopicDto; canDecide: boolean }) {
  const accept = useAcceptTopic();
  const reject = useRejectTopic();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(t.question ?? '');
  const [area, setArea] = useState(t.area ?? 'other');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [terms, setTerms] = useState<string[]>([]);

  // The scrubber runs live while the question is edited (nothing is saved).
  useEffect(() => {
    if (!editing) return;
    const h = setTimeout(() => {
      checkTopic({ question: text, area: area as never, allowTerms: terms })
        .then((r) => setFindings(r.findings))
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(h);
  }, [editing, text, area, terms]);

  const blocked = accept.error instanceof ApiError && accept.error.code === 'topic_blocked';
  const shown: Finding[] = editing
    ? findings
    : blocked
      ? (((accept.error as ApiError).details as { findings?: Finding[] } | undefined)?.findings ?? [])
      : [];
  const nouns = shown
    .filter((f) => f.code === 'unknown_proper_noun' && f.detail)
    .map((f) => f.detail as string);
  const onlyNouns = shown.length > 0 && shown.every((f) => f.code === 'unknown_proper_noun');

  return (
    <li className="py-3" data-testid="ceo-topic" data-status={t.status}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea
            label="Question"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            hint="One general question, 30 to 160 characters, ending with a question mark. No names."
            data-testid="ceo-topic-edit"
          />
          <Select label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
            {TOPIC_AREAS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <p className="text-sm font-medium text-fg" data-testid="ceo-topic-question">
          {t.question}
        </p>
      )}
      <p className="mt-0.5 text-xs text-muted">
        {t.area} · {evidenceText(t)}
        {t.occurrences > 1 ? ` · seen ${t.occurrences} times` : ''}
      </p>
      {shown.length > 0 && (
        <div className="mt-2" data-testid="ceo-topic-findings">
          <Callout tone="warning" title="This question is not generic enough to send">
            <ul className="list-disc pl-5">
              {shown.map((f) => (
                <li key={`${f.code}-${f.detail ?? ''}`}>
                  {FINDING_TEXT[f.code] ?? f.code}
                  {f.detail && f.code !== 'first_person' && f.code !== 'deny_list' ? ` (${f.detail})` : ''}
                </li>
              ))}
            </ul>
            {onlyNouns && !terms.length && (
              <Button
                className="mt-2"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setTerms(nouns);
                  setEditing(true);
                }}
                data-testid="ceo-topic-confirm-terms"
              >
                These are public technologies: allow them
              </Button>
            )}
          </Callout>
        </div>
      )}
      {canDecide && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={accept.isPending}
            disabled={editing && findings.length > 0}
            onClick={() =>
              accept.mutate(
                {
                  id: t.id,
                  ...(editing ? { question: text, area: area as never } : {}),
                  ...(terms.length ? { allowTerms: terms } : {}),
                },
                { onSuccess: () => setEditing(false) },
              )
            }
            data-testid="ceo-topic-accept"
          >
            {editing ? 'Accept this wording' : 'Accept'}
          </Button>
          {editing ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)} data-testid="ceo-topic-edit-button">
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            loading={reject.isPending}
            onClick={() => reject.mutate({ id: t.id })}
            data-testid="ceo-topic-reject"
          >
            Reject
          </Button>
        </div>
      )}
      {!(blocked && shown.length > 0) && <ErrorBox error={accept.error ?? reject.error} />}
    </li>
  );
}

/**
 * The daily report's two topic sections: what is waiting for the Owner (Accept / Edit / Reject), and the articles
 * published from topics the organization sent. Reads the live list, so a decision shows at once.
 */
export function TopicsReportSection() {
  const q = useCeoTopics();
  const canDecide = useCanDecideTopics(q.data);
  if (!q.data?.enabled) return null;
  const proposed = q.data.topics.filter((t) => t.status === 'proposed');
  const published = q.data.topics.filter((t) => t.status === 'published' && t.postSlug);
  if (!proposed.length && !published.length) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="ceo-report-topics">
      {proposed.length > 0 && (
        <div data-testid="ceo-report-topics-proposed">
          <h3 className="text-sm font-semibold text-fg">Research topics from this week</h3>
          <p className="text-xs text-muted">
            {q.data.ownerOnly
              ? 'These might make good blog articles for the community. Nothing is sent to Guildwise without your Accept; only the question is sent, with no names.'
              : 'Questions for the Guildwise blog. Accept sends the question to the writer.'}
          </p>
          <ul className="mt-1 divide-y divide-line">
            {proposed.map((t) => (
              <ProposedTopic key={t.id} topic={t} canDecide={canDecide} />
            ))}
          </ul>
        </div>
      )}
      {published.length > 0 && (
        <div data-testid="ceo-report-topics-published">
          <h3 className="text-sm font-semibold text-fg">Published from your topics</h3>
          <ul className="mt-1 divide-y divide-line text-sm">
            {published.map((t) => (
              <li key={t.id} className="py-1.5">
                <a href={`/blog/${t.postSlug}`} className="text-brand-text hover:underline">
                  {t.postTitle ?? t.question}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
