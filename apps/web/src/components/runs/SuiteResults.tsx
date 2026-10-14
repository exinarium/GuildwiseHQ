import type { CardDetailResponse, SuiteStatus, TestSuiteResultDto } from '@aom/shared';
import { attachmentUrl } from '../../api/queries/attachments.ts';
import { usePatchCard } from '../../api/queries/cards.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, ErrorBox, Panel } from '../ui.tsx';

type Testing = NonNullable<CardDetailResponse['testing']>;

const TONE: Record<SuiteStatus, 'green' | 'red' | 'amber' | 'neutral'> = {
  passed: 'green',
  flaky: 'amber',
  failed: 'red',
  timeout: 'red',
  skipped: 'neutral',
};

const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);

function where(r: TestSuiteResultDto): string {
  if (r.envMode === 'remote') return r.targetName ? `target ${r.targetName}` : 'deployed target';
  if (r.envMode === 'local') return r.commit ? `this branch, commit ${r.commit.slice(0, 7)}` : 'this branch';
  return '';
}

/**
 * The integration and E2E tests the tester ran on the card (backlog #59): one row per run, so a failure followed by a
 * passing re-run shows both, and a link to the environment while a failed card's copy is kept.
 */
export function SuiteResultsPanel({ cardId, testing }: { cardId: string; testing: Testing }) {
  const results = testing.suiteResults ?? [];
  const env = testing.testEnvironment;
  if (results.length === 0 && !env) return null;
  const flaky = results.filter((r) => r.status === 'flaky');
  return (
    <Panel title="Integration tests">
      <div data-testid="suite-results" className="flex flex-col gap-3">
        {env && (
          <p className="text-sm text-muted" data-testid="test-environment">
            Test environment on {env.workstationName}:{' '}
            <Badge tone={env.state === 'healthy' ? 'green' : env.state === 'failed' ? 'red' : 'neutral'}>
              {env.state}
            </Badge>
            {env.activity ? ` (${env.activity})` : ''}
            {env.commit ? `, commit ${env.commit.slice(0, 7)}` : ''}
            {env.urls.length > 0 && (
              <>
                {' '}
                ·{' '}
                {env.urls.map((u) => (
                  <code key={u} className="mr-2 font-mono text-xs">
                    {u}
                  </code>
                ))}
              </>
            )}
            {env.keptUntil && (
              <span data-testid="env-kept"> Kept for inspection until {formatDateTime(env.keptUntil)}.</span>
            )}
            {env.lastError && env.state === 'failed' ? ` ${env.lastError}` : ''}
          </p>
        )}
        {flaky.length > 0 && (
          <p className="text-sm text-muted" data-testid="flaky-notice">
            {flaky.map((r) => r.suite).join(', ')} failed first and passed on a re-run: it counts as passed
            but is marked flaky.
          </p>
        )}
        {results.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-xs text-subtle">
                <tr>
                  <th className="py-1 pr-3 font-medium">Suite</th>
                  <th className="py-1 pr-3 font-medium">Result</th>
                  <th className="py-1 pr-3 font-medium">Passed / failed / skipped</th>
                  <th className="py-1 pr-3 font-medium">Time</th>
                  <th className="py-1 font-medium">Against</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-line align-top"
                    data-testid="suite-result"
                    data-status={r.status}
                  >
                    <td className="py-1.5 pr-3">
                      <span className="font-medium text-fg">{r.suite}</span>
                      {r.kind && (
                        <span className="ml-1 text-xs text-subtle">
                          {r.kind === 'e2e' ? 'end-to-end' : 'integration'}
                        </span>
                      )}
                      {r.attempts > 1 && (
                        <span className="ml-1 text-xs text-subtle">attempt {r.attempts}</span>
                      )}
                      {r.failures.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-xs text-muted">
                          {r.failures.slice(0, 3).map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={TONE[r.status]}>{r.status}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {r.passed} / {r.failed} / {r.skipped}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{seconds(r.durationMs)}</td>
                    <td className="py-1.5 text-muted">
                      {where(r)}
                      {r.attachmentId && (
                        <>
                          {where(r) ? ' · ' : ''}
                          <a
                            className="text-brand-text underline"
                            href={attachmentUrl(cardId, r.attachmentId, true)}
                          >
                            log
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * "Integration tests" switch of a card (Details panel): follows the project's setting when the card is specified and can
 * be changed until the Test stage starts.
 */
export function IntegrationTestsToggle({
  cardId,
  value,
  editable,
}: {
  cardId: string;
  value: boolean;
  editable: boolean;
}) {
  const patch = usePatchCard(cardId);
  return (
    <div>
      <dt className="text-xs font-medium text-subtle">Integration tests</dt>
      <dd className="text-fg" data-testid="integration-toggle">
        {editable ? (
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value}
              disabled={patch.isPending}
              onChange={(e) => patch.mutate({ integrationTests: e.target.checked })}
            />
            {value ? 'The tester runs them' : 'Skipped for this card'}
          </label>
        ) : (
          <span>{value ? 'yes' : 'skipped'}</span>
        )}
        <ErrorBox error={patch.error} />
      </dd>
    </div>
  );
}
