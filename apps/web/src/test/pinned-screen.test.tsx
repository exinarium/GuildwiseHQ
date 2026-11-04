import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PinnedScreen } from '../components/PinnedScreen.tsx';

const realMatchMedia = window.matchMedia;
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && /max-width:\s*767\.98px/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('PinnedScreen', () => {
  it('on a phone fills the shell main area, with no inline offsets', () => {
    setViewport(true);
    render(
      <PinnedScreen desktopClassName="h-96" testId="pinned">
        <p>chat</p>
      </PinnedScreen>,
    );
    const el = screen.getByTestId('pinned');
    expect(el).toHaveClass('absolute', 'inset-0', 'overflow-hidden');
    expect(el).not.toHaveClass('fixed');
    expect(el.getAttribute('style')).toBeNull();
  });

  it('from md up stays a normal block', () => {
    setViewport(false);
    render(
      <PinnedScreen desktopClassName="h-96" testId="pinned">
        <p>chat</p>
      </PinnedScreen>,
    );
    const el = screen.getByTestId('pinned');
    expect(el).toHaveClass('flex', 'flex-col', 'h-96');
    expect(el).not.toHaveClass('absolute');
  });
});
