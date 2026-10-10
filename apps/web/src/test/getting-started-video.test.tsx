import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GettingStartedVideo } from '../components/help/GettingStartedVideo.tsx';

const info = {
  title: 'Getting started with Guildwise HQ',
  src: '/videos/getting-started.webm',
  type: 'video/webm',
  duration: 120,
  chapters: [
    { t: 0, title: 'Create your first project' },
    { t: 30, title: 'Hire your agents' },
    { t: 65.5, title: 'Create cards' },
  ],
};

const respond = (body: unknown, ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  );

afterEach(() => vi.unstubAllGlobals());

describe('the getting-started video', () => {
  it('shows the player with one button per chapter, each seeking to its time', async () => {
    respond(info);
    const user = userEvent.setup();
    render(<GettingStartedVideo />);
    const player = (await screen.findByTestId('getting-started-player')) as HTMLVideoElement;
    expect(player.querySelector('source')).toHaveAttribute('src', '/videos/getting-started.webm');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('video-chapter-3')).toHaveTextContent('1:05');
    player.play = vi.fn(async () => undefined);
    await user.click(screen.getByTestId('video-chapter-2'));
    expect(player.currentTime).toBe(30);
  });

  it('says it is coming soon when there is no video yet (an HTML fallback page, a 404 or a network error)', async () => {
    for (const setup of [
      () => respond(null),
      () => respond({}, false),
      () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))),
    ]) {
      setup();
      const { unmount } = render(<GettingStartedVideo />);
      await waitFor(() => expect(screen.getByTestId('video-coming-soon')).toBeInTheDocument());
      expect(screen.queryByTestId('getting-started-player')).toBeNull();
      unmount();
    }
  });
});
