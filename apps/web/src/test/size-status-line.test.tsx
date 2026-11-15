import type { ProjectDetailResponse } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SizeStatusLine } from '../components/ReviewSettingsPanel.tsx';

type Dto = NonNullable<ProjectDetailResponse['project']['sizeStatus']>;
const dto = (over: Partial<Dto>): Dto => ({
  context: 'size-budget',
  state: 'active',
  failing: 0,
  lastPostedAt: null,
  ...over,
});
const line = () => screen.getByTestId('size-status-line');

describe('hard size check line (GWP-211)', () => {
  it('inactive: says a budget and unit are needed (AC5)', () => {
    render(<SizeStatusLine sizeStatus={dto({ state: 'inactive' })} />);
    expect(line()).toHaveTextContent('Hard size check: inactive until a size budget and unit are set.');
  });

  it('active: names the status, how to make it required, and the failing count', () => {
    render(<SizeStatusLine sizeStatus={dto({ failing: 2 })} />);
    expect(line()).toHaveTextContent(
      'Hard size check: posts the status size-budget on every pull request. To block merging, make it required on the branch (Guide 4.3d). 2 pull requests are over budget.',
    );
  });

  it('active with one failing PR uses the singular, with none says nothing about failing', () => {
    const { unmount } = render(<SizeStatusLine sizeStatus={dto({ failing: 1 })} />);
    expect(line()).toHaveTextContent('1 pull request is over budget.');
    unmount();
    render(<SizeStatusLine sizeStatus={dto({ failing: 0 })} />);
    expect(line()).not.toHaveTextContent('over budget.');
  });

  it('no token: names the command to run, in a copyable element', () => {
    render(<SizeStatusLine sizeStatus={dto({ state: 'no_token' })} />);
    expect(line()).toHaveTextContent('no workstation has a status token');
    expect(screen.getByText('guildwise-runner status-token github').tagName).toBe('CODE');
  });

  it('no runner: says it waits for a workstation', () => {
    render(<SizeStatusLine sizeStatus={dto({ state: 'no_runner' })} />);
    expect(line()).toHaveTextContent('waiting for a workstation with the clone to come online');
  });
});
