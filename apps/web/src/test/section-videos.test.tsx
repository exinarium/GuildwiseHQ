import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageVideo, SectionVideo } from '../components/help/SectionVideo.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { TourVideo } from '../components/tour/TourVideo.tsx';
import { ARTICLES, articleBySlug } from '../help/articles.ts';
import { Markdown } from '../help/Markdown.tsx';
import {
  navIdForPath,
  publishedVideo,
  SECTION_VIDEOS,
  videoForNav,
  videoForPath,
  videosForArticle,
} from '../lib/videos.ts';

const info = (slug: string) => ({
  title: `Video ${slug}`,
  src: `/videos/${slug}.webm`,
  type: 'video/webm',
  captions: `/videos/${slug}.vtt`,
  duration: 70,
  chapters: [
    { t: 0, title: 'First' },
    { t: 30, title: 'Second' },
  ],
});

/** Serves the chapters JSON of the listed slugs; every other URL answers with the HTML fallback page. */
const serve = (...slugs: string[]) => {
  const fetchMock = vi.fn(async (url: string) => {
    const slug = slugs.find((s) => url === `/videos/${s}.json`);
    return slug
      ? { ok: true, json: async () => info(slug) }
      : { ok: true, json: async () => Promise.reject(new Error('not json')) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const publish = (...slugs: string[]) => {
  for (const s of slugs) (SECTION_VIDEOS[s] as { published: boolean }).published = true;
};
let before: Record<string, boolean>;
beforeEach(() => {
  before = Object.fromEntries(Object.entries(SECTION_VIDEOS).map(([k, v]) => [k, v.published]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(before)) (SECTION_VIDEOS[k] as { published: boolean }).published = v;
  vi.unstubAllGlobals();
});

describe('the video registry', () => {
  it('has 25 videos: Getting started and one per section, with unique kebab-case slugs', () => {
    const slugs = Object.keys(SECTION_VIDEOS);
    expect(slugs).toHaveLength(25);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('points every section video at a real sidebar entry (or the platform area) and a real Help anchor', () => {
    const { sections, footer } = buildNav({
      projectKey: 'X',
      hasResearch: true,
      hasEnvironments: true,
      canManage: true,
    });
    const navIds = new Set([...sections.flatMap((s) => s.items), ...footer].map((e) => e.id));
    const seen = new Set<string>();
    for (const [slug, e] of Object.entries(SECTION_VIDEOS)) {
      if (e.nav !== null) {
        expect(navIds.has(e.nav) || e.nav === 'platform', `${slug}: nav ${e.nav}`).toBe(true);
        expect(seen.has(e.nav), `${slug}: nav ${e.nav} used twice`).toBe(false);
        seen.add(e.nav);
      }
      const [article, anchor] = e.help.split('#');
      const a = articleBySlug(article as string);
      expect(a, `${slug}: article ${article}`).toBeDefined();
      expect(
        a?.headings.some((h) => h.id === anchor),
        `${slug}: ${e.help}`,
      ).toBe(true);
    }
    // every sidebar entry has a video
    for (const id of navIds) expect(seen.has(id), `no video for ${id}`).toBe(true);
    expect(ARTICLES.length).toBeGreaterThan(0);
  });

  it('only publishes videos whose files exist', () => {
    for (const [slug, e] of Object.entries(SECTION_VIDEOS)) {
      if (!e.published) continue;
      for (const ext of ['json', 'webm', 'mp4', 'vtt'])
        expect(existsSync(join(__dirname, `../../public/videos/${slug}.${ext}`)), `${slug}.${ext}`).toBe(
          true,
        );
    }
  });

  it('finds a video by nav id, article and path only when it is published', () => {
    expect(videoForNav('desk')).toBeUndefined();
    expect(videosForArticle('desk')).toEqual([]);
    expect(videoForPath('/desk')).toBeUndefined();
    publish('desk');
    expect(publishedVideo('desk')?.title).toBe('Your Desk');
    expect(videoForNav('desk')?.slug).toBe('desk');
    expect(videosForArticle('desk').map((v) => [v.slug, v.anchor])).toEqual([['desk', 'desk-items']]);
    expect(videoForPath('/desk')?.slug).toBe('desk');
  });

  it('maps a page to its sidebar section', () => {
    expect(navIdForPath('/p/ABC/board')).toBe('board');
    expect(navIdForPath('/cards/123')).toBe('board');
    expect(navIdForPath('/p/ABC/backlog')).toBe('backlog');
    expect(navIdForPath('/desk')).toBe('desk');
    expect(navIdForPath('/p/ABC/environments')).toBe('environments');
    expect(navIdForPath('/p/ABC/research')).toBe('research');
    expect(navIdForPath('/org/workflows/w1')).toBe('org');
    expect(navIdForPath('/org/ceo')).toBe('ceo');
    expect(navIdForPath('/settings')).toBe('settings');
    expect(navIdForPath('/settings/org')).toBe('organization');
    expect(navIdForPath('/settings/vaults')).toBe('vaults');
    expect(navIdForPath('/workstations/w1/integrations')).toBe('integrations');
    expect(navIdForPath('/help/desk')).toBe('help');
    expect(navIdForPath('/platform/orgs')).toBe('platform');
  });
});

describe('SectionVideo', () => {
  it('shows nothing, and asks for nothing, while the video is not published', async () => {
    const f = serve('desk');
    const { container } = render(<SectionVideo slug="desk" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(f).not.toHaveBeenCalled();
  });

  it('shows the player of a published video, with its own test id and captions', async () => {
    publish('desk');
    serve('desk');
    render(<SectionVideo slug="desk" />);
    const player = (await screen.findByTestId('desk-player')) as HTMLVideoElement;
    expect(player.querySelector('source')).toHaveAttribute('src', '/videos/desk.webm');
    expect(player.querySelector('track')).toHaveAttribute('src', '/videos/desk.vtt');
    expect(screen.getByRole('heading', { name: 'Your Desk' })).toBeInTheDocument();
    expect(screen.getByTestId('video-chapter-2')).toHaveTextContent('0:30');
  });

  it('shows nothing when a published video has no chapters JSON', async () => {
    publish('desk');
    const f = serve();
    const { container } = render(<SectionVideo slug="desk" />);
    await waitFor(() => expect(f).toHaveBeenCalledWith('/videos/desk.json', expect.anything()));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the Watch the video button of the page help', () => {
  it('is absent on a page without a published video', async () => {
    serve('desk');
    const { container } = render(<PageVideo pathname="/desk" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('is absent when the video is published but its file is missing', async () => {
    publish('desk');
    const f = serve();
    const { container } = render(<PageVideo pathname="/desk" />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('opens and closes the player of the page section', async () => {
    publish('desk');
    serve('desk');
    const user = userEvent.setup();
    render(<PageVideo pathname="/desk" />);
    await user.click(await screen.findByRole('button', { name: 'Watch the video' }));
    expect(await screen.findByTestId('desk-player')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide the video' }));
    expect(screen.queryByTestId('desk-player')).toBeNull();
  });
});

describe('a Help article', () => {
  const article = (slug: string) => articleBySlug(slug) as NonNullable<ReturnType<typeof articleBySlug>>;
  const view = () => (
    <MemoryRouter>
      <Markdown
        blocks={article('desk').blocks}
        afterHeading={(id) =>
          videosForArticle('desk')
            .filter((v) => v.anchor === id)
            .map((v) => <SectionVideo key={v.slug} slug={v.slug} />)
        }
      />
    </MemoryRouter>
  );

  it('shows no video under a heading until one is published', async () => {
    serve('desk');
    render(view());
    await Promise.resolve();
    expect(screen.queryByTestId('section-video-desk')).toBeNull();
  });

  it('shows the published video right under the heading it is registered for', async () => {
    publish('desk');
    serve('desk');
    render(view());
    const box = await screen.findByTestId('section-video-desk');
    const heading = document.getElementById('desk-items');
    expect(heading?.nextElementSibling).toBe(box);
  });
});

describe('a video in a tour card', () => {
  it('shows only a published section video, and tells the card when it appears', async () => {
    const shown = vi.fn();
    serve('desk');
    const first = render(<TourVideo slug="desk" onShown={shown} />);
    await Promise.resolve();
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    publish('desk');
    render(<TourVideo slug="desk" onShown={shown} />);
    expect(await screen.findByTestId('tour-video')).toBeInTheDocument();
    expect(screen.getByTestId('desk-player')).toBeInTheDocument();
    expect(shown).toHaveBeenLastCalledWith(true);
  });
});
