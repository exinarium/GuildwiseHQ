import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptyAnswers } from '../components/environments/answers.ts';
import { EnvReview } from '../components/environments/EnvReview.tsx';

const answers = { ...emptyAnswers('test', 'Test site'), name: 'test-site' };

const preview = (changes: Array<{ group: string; text: string; env: string }>, extra: object = {}) =>
  ({
    ok: true,
    issues: [],
    hash: 'h'.repeat(64),
    files: [],
    keep: [],
    lint: [],
    changes,
    differsFromCurrent: true,
    needsDryRun: [],
    ...extra,
  }) as never;

const show = (p: ReturnType<typeof preview> | undefined, over: Record<string, unknown> = {}) =>
  render(
    <EnvReview
      answers={answers}
      preview={p}
      previewing={false}
      previewError={null}
      changes={[]}
      publishError={null}
      saving={false}
      written={false}
      failed={null}
      onSave={() => {}}
      onAgain={() => {}}
      onDone={() => {}}
      onAdvanced={() => {}}
      removeFiles={[]}
      onToggleRemove={() => {}}
      {...over}
    />,
  );

const OTHER = { group: 'setup_once', text: 'The live database has no backup folder.', env: 'live' };
const OWN = { group: 'setup_once', text: 'The test app has no compose file.', env: 'test-site' };

describe('EnvReview: a blocker of another environment', () => {
  it('does not disable Save, and is shown with the environment name', () => {
    show(preview([OTHER, { group: 'reuse', text: 'Found the app.', env: 'test-site' }]));
    expect(screen.getByTestId('review-save')).toBeEnabled();
    expect(screen.queryByTestId('review-save-reason')).toBeNull();
    const info = screen.getByTestId('review-other-blockers');
    expect(within(info).getByText(/live:/)).toBeInTheDocument();
    expect(info).toHaveTextContent('The live database has no backup folder.');
  });

  it('its own blocker disables Save and says why next to the button', () => {
    show(preview([OWN, OTHER]));
    expect(screen.getByTestId('review-save')).toBeDisabled();
    expect(screen.getByTestId('review-save-reason')).toHaveTextContent('still needs something set up first');
  });

  it('any disabled Save shows a reason', () => {
    show(undefined);
    expect(screen.getByTestId('review-save')).toBeDisabled();
    expect(screen.getByTestId('review-save-reason')).toHaveTextContent('until the steps are prepared');
  });
});
