import { type BlogTopic, TOPIC_AREAS, type TopicStatus } from '@aom/shared';
import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import {
  useAddBlogTopic,
  useBlogTopics,
  useMoveBlogTopic,
  useRejectBlogTopic,
} from '../../api/queries/blog.ts';
import { formatDateTime } from '../../lib/time.ts';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../ui.tsx';

const STATUS_LABEL: Record<TopicStatus, string> = {
  queued: 'Queued',
  writing: 'Being written',
  drafted: 'Article in review',
  published: 'Published',
  declined: 'Declined',
  rejected: 'Removed',
  duplicate: 'Already covered',
};
const STATUS_TONE: Record<TopicStatus, 'neutral' | 'brand' | 'success' | 'danger' | 'warning' | 'info'> = {
  queued: 'info',
  writing: 'warning',
  drafted: 'warning',
  published: 'success',
  declined: 'danger',
  rejected: 'neutral',
  duplicate: 'neutral',
};

/** What each scrubber finding means, in words for the person typing the question. */
const FINDING_TEXT: Record<string, string> = {
  too_short: 'The question is too short (at least 30 characters).',
  too_long: 'The question is too long (at most 160 characters).',
  not_a_question: 'It must end with a question mark.',
  more_than_one_sentence: 'Use one sentence.',
  bad_area: 'Pick an area.',
  non_ascii: 'Use plain letters and punctuation only.',
  too_many_digits: 'No more than three digits.',
  symbol: 'Remove symbols such as backticks, braces, equals signs or semicolons.',
  url: 'No web addresses.',
  email: 'No e-mail addresses.',
  ip_address: 'No IP addresses.',
  host_name: 'No host names or ports.',
  file_path: 'No file paths.',
  ticket_key: 'No ticket keys.',
  identifier: 'No ids or long hex strings.',
  handle: 'No @handles.',
  quoted_text: 'No quoted text.',
  cli_flag: 'No command-line flags.',
  camel_case: 'No code identifiers (camelCase).',
  snake_case: 'No code identifiers (snake_case).',
  deny_list: 'The question names something that must stay private.',
  deny_list_similar: 'The question looks like a private name.',
  unknown_proper_noun: 'A capitalised name that is not a known public technology.',
  first_person: 'Ask about the topic, not about "we", "our" or "I".',
};

interface Finding {
  code: string;
  detail?: string;
  overridable?: boolean;
}

/** Platform > Blog > Topics: the questions the blog writer takes before its rotation, and the ones the super admin types. */
export function BlogTopicsPanel() {
  const q = useBlogTopics();
  const add = useAddBlogTopic();
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [area, setArea] = useState<string>('other');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = (allowTerms?: string[]) => {
    setFindings([]);
    setError(null);
    add.mutate(
      { question: question.trim(), area: area as never, ...(allowTerms ? { allowTerms } : {}) },
      {
        onSuccess: (r) => {
          setQuestion('');
          toast.success(r.status === 'duplicate' ? 'Saved, but it is already covered' : 'Added to the queue');
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'topic_rejected') setFindings(err.details as Finding[]);
          else setError(err instanceof Error ? err.message : 'Could not add the question');
        },
      },
    );
  };
  const terms = findings
    .filter((f) => f.code === 'unknown_proper_noun' && f.detail)
    .map((f) => f.detail as string);
  const onlyNouns = findings.length > 0 && findings.every((f) => f.code === 'unknown_proper_noun');

  return (
    <div data-testid="topics-panel">
      <Panel className="mb-5">
        <h2 className="text-lg font-semibold text-fg">Add a question</h2>
        <p className="mt-1 text-sm text-muted">
          The blog writer takes queued questions before its usual themes, one article a day by default. Write
          one general question a reader might ask, in a single sentence. It is checked before it is queued: no
          names, addresses, code or &quot;we&quot;.
        </p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          aria-label="Add a research question"
        >
          <TextArea
            label="Question"
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            hint="30 to 160 characters, ends with a question mark."
            data-testid="topic-question"
          />
          <Select
            label="Area"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            data-testid="topic-area"
          >
            {TOPIC_AREAS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Button
            type="submit"
            disabled={question.trim().length < 3 || add.isPending}
            data-testid="topic-add"
          >
            Add to queue
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        {findings.length > 0 && (
          <div className="mt-3" data-testid="topic-findings">
            <Callout tone="warning" title="This question does not pass the checks">
              <ul className="list-disc pl-5">
                {findings.map((f) => (
                  <li key={`${f.code}-${f.detail ?? ''}`}>
                    {FINDING_TEXT[f.code] ?? f.code}
                    {f.detail && f.code !== 'first_person' ? ` (${f.detail})` : ''}
                  </li>
                ))}
              </ul>
              {onlyNouns && (
                <Button
                  className="mt-2"
                  variant="secondary"
                  onClick={() => submit(terms)}
                  disabled={add.isPending}
                  data-testid="topic-confirm-terms"
                >
                  These are public technologies: add anyway
                </Button>
              )}
            </Callout>
          </div>
        )}
      </Panel>

      {q.isPending && <ListSkeleton label="Loading topics" rows={3} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.topics.length === 0 && (
        <EmptyState
          icon={Lightbulb}
          title="No topics yet"
          description="Questions you add here, and questions sent by organizations that opted in, wait in this queue until the writer takes them."
        />
      )}
      {q.data && q.data.topics.length > 0 && (
        <Panel padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="topics-table">
              <thead className="text-left text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Question</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Queued</th>
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {q.data.topics.map((t, i) => (
                  <TopicRow key={t.id} topic={t} first={i === 0} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function TopicRow({ topic: t, first }: { topic: BlogTopic; first: boolean }) {
  const reject = useRejectBlogTopic();
  const move = useMoveBlogTopic();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <tr data-testid={`topic-row-${t.id}`}>
      <td className="px-4 py-2.5">
        <span className="font-medium text-fg">{t.question}</span>
        <span className="block text-xs text-subtle">{t.area}</span>
        {t.reason && t.status !== 'queued' && <span className="block text-xs text-muted">{t.reason}</span>}
      </td>
      <td className="px-4 py-2.5">
        <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
        {t.slug && (
          <a
            className="mt-0.5 block text-xs text-brand hover:underline"
            href={t.status === 'published' ? `/blog/${t.slug}` : undefined}
          >
            {t.slug}
          </a>
        )}
      </td>
      <td className="px-4 py-2.5 text-muted">{t.origin === 'platform' ? 'Platform' : 'Community'}</td>
      <td className="px-4 py-2.5 text-muted">{formatDateTime(t.queuedAt)}</td>
      <td className="px-4 py-2.5">
        {t.status === 'queued' && !rejecting && (
          <div className="flex gap-2">
            {!first && (
              <Button
                size="sm"
                variant="ghost"
                disabled={move.isPending}
                onClick={() => move.mutate(t.id)}
                data-testid={`topic-move-${t.id}`}
              >
                Move up
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRejecting(true)}
              data-testid={`topic-reject-${t.id}`}
            >
              Remove
            </Button>
          </div>
        )}
        {t.status === 'queued' && rejecting && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              reject.mutate(
                { id: t.id, reason: reason.trim() },
                { onSuccess: () => toast.success('Removed from the queue') },
              );
            }}
          >
            <TextInput
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid={`topic-reason-${t.id}`}
            />
            <Button type="submit" size="sm" variant="danger" disabled={!reason.trim() || reject.isPending}>
              Remove
            </Button>
          </form>
        )}
      </td>
    </tr>
  );
}
