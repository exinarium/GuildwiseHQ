import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GettingStartedVideo } from '../components/help/GettingStartedVideo.tsx';
import { resetVideoManifest } from '../lib/video-manifest.ts';
import { serveVideos } from './video-fixtures.ts';

const info = {
  title: 'Getting started with Guildwise HQ',
  src: '/videos/getting-started.webm',
  type: 'video/webm',
  captions: '/videos/getting-started.vtt',
  duration: 120,
  chapters: [
    { t: 0, title: 'Create your first project' },
    { t: 30, title: 'Hire your agents' },
    { t: 65.5, title: 'Create cards' },
  ],
};

const respond = (body: unknown, ok = true) =>
  serveVideos({ listed: ['getting-started'], infos: ok && body ? ['getting-started'] : [] }, () => body);

beforeEach(() => resetVideoManifest());
afterEach(() => vi.unstubAllGlobals());

describe('the getting-started video', () => {
  it('shows the player with one button per chapter, each seeking to its time', async () => {
    respond(info);
    const user = userEvent.setup();
    render(<GettingStartedVideo />);
    const player = (await screen.findByTestId('getting-started-player')) as HTMLVideoElement;
    expect(player.querySelector('source')).toHaveAttribute(
      'src',
      '/videos/getting-started.webm?v=sha-getting-started-webm',
    );
    const track = player.querySelector('track');
    expect(track).toHaveAttribute('src', '/videos/getting-started.vtt?v=sha-getting-started-vtt');
    expect(track).toHaveAttribute('kind', 'captions');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByTestId('video-chapter-3')).toHaveTextContent('1:05');
    player.play = vi.fn(async () => undefined);
    await user.click(screen.getByTestId('video-chapter-2'));
    expect(player.currentTime).toBe(30);
  });

  it('is hidden when there is no video: no description, a missing slug in the manifest, an unreachable media service', async () => {
    for (const setup of [
      () => respond(null),
      () => respond({}, false),
      () => serveVideos({ listed: ['board'] }),
      () => serveVideos({ listed: ['getting-started'], manifest: 'down' }),
      () => serveVideos({ listed: ['getting-started'], manifest: 'unavailable' }),
      () => serveVideos({ listed: ['getting-started'], manifest: 'html' }),
    ]) {
      resetVideoManifest();
      const f = setup();
      const { container } = render(<GettingStartedVideo />);
      await waitFor(() => expect(f).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByTestId('video-coming-soon')).toBeNull();
      expect(screen.queryByTestId('getting-started-player')).toBeNull();
      cleanup();
    }
  });
});
