import type { SocialCaptions } from '@aom/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { captionStats, SocialCaptionsEditor } from '../components/blog/SocialCaptionsEditor.tsx';

function Harness({ initial = {} }: { initial?: SocialCaptions }) {
  const [v, setV] = useState<SocialCaptions>(initial);
  return (
    <>
      <SocialCaptionsEditor value={v} onChange={setV} />
      <output data-testid="value">{JSON.stringify(v)}</output>
    </>
  );
}

describe('SocialCaptionsEditor', () => {
  it('counts X with its hashtags against 256 and flags an overflow', () => {
    expect(captionStats('x', { xText: 'a'.repeat(254), hashtags: { x: ['AI'] } }).over).toBe(true);
    expect(captionStats('x', { xText: 'a'.repeat(250) })).toMatchObject({
      count: 250,
      max: 256,
      over: false,
    });
  });

  it('adds and removes hashtag chips, with the count range per network', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ xText: 'Hello' }} />);
    const x = screen.getByTestId('caption-x');
    expect(within(x).getByTestId('tags-count-x').textContent).toBe('0 of 1-2 hashtags');
    expect(
      within(screen.getByTestId('caption-linkedin')).getByTestId('tags-count-linkedin').textContent,
    ).toBe('0 of 3-5 hashtags');
    const input = within(x).getByLabelText('Add a hashtag for X');
    await user.type(input, '#Agents{Enter}');
    await user.type(within(x).getByLabelText('Add a hashtag for X'), 'AI{Enter}');
    expect(within(x).getByTestId('tags-count-x').textContent).toBe('2 of 1-2 hashtags');
    expect(within(x).queryByLabelText('Add a hashtag for X')).toBeNull(); // at the maximum
    expect(JSON.parse(screen.getByTestId('value').textContent ?? '{}').hashtags.x).toEqual(['Agents', 'AI']);
    // the exact preview carries the tags and the 23-character sample link
    expect(within(x).getByTestId('preview-x').textContent).toBe('Hello #Agents #AI https://example.com/abc');
    await user.click(within(x).getByLabelText('Remove #Agents'));
    expect(within(x).getByTestId('tags-count-x').textContent).toBe('1 of 1-2 hashtags');
  });

  it('refuses a hashtag that is not one word, and a duplicate', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const fb = screen.getByTestId('caption-facebook');
    await user.type(within(fb).getByLabelText('Add a hashtag for Facebook'), '1bad{Enter}');
    expect(within(fb).getByTestId('tags-count-facebook').textContent).toBe('0 of 0-3 hashtags');
    await user.clear(within(fb).getByLabelText('Add a hashtag for Facebook'));
    await user.type(within(fb).getByLabelText('Add a hashtag for Facebook'), 'AI{Enter}');
    await user.type(within(fb).getByLabelText('Add a hashtag for Facebook'), 'ai{Enter}');
    expect(within(fb).getByTestId('tags-count-facebook').textContent).toBe('1 of 0-3 hashtags');
  });

  it('shows Bluesky without a link and LinkedIn escaped', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          blueskyText: 'Hi',
          linkedinText: 'Hi (there)',
          hashtags: { bluesky: ['AI'], linkedin: ['Agents'] },
        }}
      />,
    );
    expect(screen.getByTestId('preview-bluesky').textContent).toBe('Hi #AI');
    expect(screen.getByTestId('preview-linkedin').textContent).toBe('Hi \\(there\\)\n\n#Agents');
    await user.type(screen.getByLabelText('Bluesky caption'), '!');
    expect(screen.getByTestId('counter-bluesky').textContent).toContain('/ 300');
  });
});
