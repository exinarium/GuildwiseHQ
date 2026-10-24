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
import { resetVideoManifest } from '../lib/video-manifest.ts';
import {
  GETTING_STARTED_SLUG,
  navIdForPath,
  publishedVideo,
  SECTION_VIDEOS,
  videoForNav,
  videoForPath,
  videosForArticle,
} from '../lib/videos.ts';
import { serveVideos } from './video-fixtures.ts';

/** The media service lists and serves the chapters JSON of the given slugs; every other URL answers with the HTML fallback page. */
const serve = (...slugs: string[]) => serveVideos({ listed: slugs });

const publish = (...slugs: string[]) => {
  for (const s of slugs) (SECTION_VIDEOS[s] as { published: boolean }).published = true;
};
/** Every video is recorded and published; the tests of the "not published yet" paths take one back. */
const unpublish = (...slugs: string[]) => {
  for (const s of slugs) (SECTION_VIDEOS[s] as { published: boolean }).published = false;
};
let before: Record<string, boolean>;
beforeEach(() => {
  resetVideoManifest();
  before = Object.fromEntries(Object.entries(SECTION_VIDEOS).map(([k, v]) => [k, v.published]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(before)) (SECTION_VIDEOS[k] as { published: boolean }).published = v;
  vi.unstubAllGlobals();
});

describe('the video registry', () => {
  it('has 29 videos: Getting started and one per section, with unique kebab-case slugs', () => {
    const slugs = Object.keys(SECTION_VIDEOS);
    expect(slugs).toHaveLength(29);
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
        expect(existsSync(join(__dirname, `../../../../media/videos/${slug}.${ext}`)), `${slug}.${ext}`).toBe(
          true,
        );
    }
  });

  it('publishes every recorded video, each with its four files (Discovery, Documents and Boardroom wait for their recording)', () => {
    const waiting = new Set(['discovery', 'documents', 'boardroom', 'capabilities']);
    for (const [slug, e] of Object.entries(SECTION_VIDEOS))
      expect(e.published, slug).toBe(!waiting.has(slug));
  });

  it('finds a video by nav id, article and path for every section', () => {
    publish('discovery', 'documents', 'boardroom', 'capabilities'); // not recorded yet: published for this check only (restored after each test)
    for (const [slug, e] of Object.entries(SECTION_VIDEOS)) {
      if (slug === GETTING_STARTED_SLUG) continue; // its own player on Help and in the tour (tour.test.tsx)
      if (e.nav) expect(videoForNav(e.nav)?.slug, slug).toBe(slug);
      const [article, anchor] = e.help.split('#');
      expect(
        videosForArticle(article as string).some((v) => v.slug === slug && v.anchor === anchor),
        slug,
      ).toBe(true);
    }
  });

  it('finds a video by nav id, article and path only when it is published', () => {
    unpublish('desk');
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
    unpublish('desk');
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
    expect(player.querySelector('source')).toHaveAttribute('src', '/videos/desk.webm?v=sha-desk-webm');
    expect(player.querySelector('track')).toHaveAttribute('src', '/videos/desk.vtt?v=sha-desk-vtt');
    expect(screen.getByRole('heading', { name: 'Your Desk' })).toBeInTheDocument();
    expect(screen.getByTestId('video-chapter-2')).toHaveTextContent('0:30');
  });

  it('shows nothing when a published video has no chapters JSON', async () => {
    publish('desk');
    const f = serveVideos({ listed: ['desk'], infos: [] });
    const { container } = render(<SectionVideo slug="desk" />);
    await waitFor(() =>
      expect(f).toHaveBeenCalledWith('/videos/desk.json?v=sha-desk-json', expect.anything()),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when the manifest does not list the slug (the video is not in the media image)', async () => {
    publish('desk');
    const f = serveVideos({ listed: ['board'], infos: ['desk'] });
    const { container } = render(<SectionVideo slug="desk" />);
    await waitFor(() => expect(f).toHaveBeenCalledWith('/videos/manifest.json', expect.anything()));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(f).not.toHaveBeenCalledWith(expect.stringContaining('desk.json'), expect.anything());
  });

  it.each(['down', 'unavailable', 'html'] as const)(
    'shows nothing when the manifest is unavailable (%s): no player, no request for the video',
    async (manifest) => {
      publish('desk');
      const f = serveVideos({ listed: ['desk'], manifest });
      const { container } = render(<SectionVideo slug="desk" />);
      await waitFor(() => expect(f).toHaveBeenCalledWith('/videos/manifest.json', expect.anything()));
      await Promise.resolve();
      await Promise.resolve();
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByTestId('desk-player')).toBeNull();
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it('asks for the manifest once for all the videos of a page', async () => {
    publish('desk', 'board');
    const f = serve('desk', 'board');
    render(
      <>
        <SectionVideo slug="desk" />
        <SectionVideo slug="board" />
      </>,
    );
    await screen.findByTestId('desk-player');
    await screen.findByTestId('board-player');
    expect(f.mock.calls.filter(([u]) => u === '/videos/manifest.json')).toHaveLength(1);
  });
});

describe('the Watch the video button of the page help', () => {
  it('is absent on a page without a published video', async () => {
    unpublish('desk');
    serve('desk');
    const { container } = render(<PageVideo pathname="/desk" />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('is absent when the video is published but the media service does not have it', async () => {
    publish('desk');
    const f = serveVideos({ listed: [] });
    const { container } = render(<PageVideo pathname="/desk" />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    await Promise.resolve();
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
    unpublish('desk');
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

describe('every published video on its three places', () => {
  it("Help, the tour card and the page help's Watch the video show each section video", async () => {
    publish('discovery', 'documents', 'boardroom', 'capabilities'); // not recorded yet: published for this check only (restored after each test)
    const user = userEvent.setup();
    const paths: Record<string, string> = {
      board: '/p/X/board',
      backlog: '/p/X/backlog',
      environments: '/p/X/environments',
      research: '/p/X/research',
    };
    for (const [slug, e] of Object.entries(SECTION_VIDEOS)) {
      if (slug === GETTING_STARTED_SLUG) continue; // its own player on Help and in the tour (tour.test.tsx)
      resetVideoManifest();
      serve(slug);
      // Help: the article shows the player under the registered heading
      const [article] = e.help.split('#');
      const help = render(
        <MemoryRouter>
          <Markdown
            blocks={articleBySlug(article as string)?.blocks ?? []}
            afterHeading={(id) =>
              videosForArticle(article as string)
                .filter((v) => v.anchor === id && v.slug === slug)
                .map((v) => <SectionVideo key={v.slug} slug={v.slug} />)
            }
          />
        </MemoryRouter>,
      );
      expect(await screen.findByTestId(`${slug}-player`), `${slug}: Help`).toBeInTheDocument();
      help.unmount();
      // the tour card
      const tour = render(<TourVideo slug={slug} onShown={() => {}} />);
      expect(await screen.findByTestId(`${slug}-player`), `${slug}: tour`).toBeInTheDocument();
      tour.unmount();
      // the page help (section videos only: Getting started has no page of its own)
      if (!e.nav) continue;
      const path =
        paths[e.nav] ?? (e.nav === 'platform' ? '/platform/orgs' : (buildNavPath(e.nav) ?? `/${e.nav}`));
      const page = render(<PageVideo pathname={path} />);
      await user.click(await screen.findByRole('button', { name: 'Watch the video' }));
      expect(
        await screen.findByTestId(`${slug}-player`),
        `${slug}: page help on ${path}`,
      ).toBeInTheDocument();
      page.unmount();
      vi.unstubAllGlobals();
    }
  });
});

/** The sidebar link of a nav entry (with every optional entry on). */
function buildNavPath(nav: string): string | undefined {
  const { sections, footer } = buildNav({
    projectKey: 'X',
    hasResearch: true,
    hasEnvironments: true,
    canManage: true,
  });
  return [...sections.flatMap((s) => s.items), ...footer].find((i) => i.id === nav)?.to;
}

describe('a video in a tour card', () => {
  it('shows only a published section video, and tells the card when it appears', async () => {
    const shown = vi.fn();
    unpublish('desk');
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
