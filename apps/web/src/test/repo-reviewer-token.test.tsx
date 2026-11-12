import type { ProjectRepoDto } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RepoReviewerTokenStatus } from '../components/RepoReviewerTokenStatus.tsx';

const repo = (over: Partial<ProjectRepoDto> = {}): ProjectRepoDto => ({
  id: '0192f3a0-0000-7000-8000-000000000001',
  projectId: '0192f3a0-0000-7000-8000-000000000002',
  name: 'app',
  remoteUrl: 'https://github.com/acme/app.git',
  remoteUrlNormalized: 'github.com/acme/app',
  workingBranch: null,
  removedAt: null,
  prOnly: true,
  ...over,
});

describe('AC4: the owner sees "reviewer token missing" on a PR-only repository', () => {
  it('shows the missing state, how DevOps sets it, and has no input to type a token into', () => {
    const { container } = render(<RepoReviewerTokenStatus repo={repo({ reviewerToken: 'missing' })} />);
    const box = screen.getByTestId('repo-reviewer-token-app');
    expect(box.textContent).toMatch(/Reviewer token missing/);
    expect(box.textContent).toMatch(/guildwise-runner reviewer-token set/);
    expect(box.textContent).toMatch(/stays on the workstation/);
    expect(container.querySelector('input, textarea, button')).toBeNull();
  });

  it('shows a neutral line when a workstation holds the token', () => {
    render(<RepoReviewerTokenStatus repo={repo({ reviewerToken: 'present' })} />);
    const box = screen.getByTestId('repo-reviewer-token-app');
    expect(box.textContent).toMatch(/Reviewer token set on a workstation/);
    expect(box.textContent).not.toMatch(/missing/i);
  });

  it('renders nothing when the repository is not PR-only or the state is not known', () => {
    const a = render(<RepoReviewerTokenStatus repo={repo({ prOnly: false, reviewerToken: null })} />);
    expect(a.container.innerHTML).toBe('');
    const b = render(<RepoReviewerTokenStatus repo={repo({ reviewerToken: undefined })} />);
    expect(b.container.innerHTML).toBe('');
    const c = render(<RepoReviewerTokenStatus repo={repo({ prOnly: false, reviewerToken: 'missing' })} />);
    expect(c.container.innerHTML).toBe('');
  });
});
