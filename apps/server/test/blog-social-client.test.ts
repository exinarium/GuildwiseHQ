import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocialClient, SocialError } from '../src/blog/social-client.ts';
import { blueskyPost, fitCaption, graphemes, xTweetText } from '../src/blog/social-text.ts';

const LINK = 'https://guildwise.example/blog/some-post?utm_source=x&utm_medium=social';

describe('caption rules', () => {
  it('cuts the X caption so caption + space + 23 fits 280', () => {
    const t = xTweetText('word '.repeat(100), LINK);
    expect(t.endsWith(` ${LINK}`)).toBe(true);
    const caption = t.slice(0, t.length - LINK.length - 1);
    expect(graphemes(caption).length).toBeLessThanOrEqual(256);
    expect(graphemes(caption).length + 1 + 23).toBeLessThanOrEqual(280);
    expect(caption.endsWith('…')).toBe(true);
  });
  it('leaves a short caption alone', () => {
    expect(xTweetText('Short one', LINK)).toBe(`Short one ${LINK}`);
    expect(fitCaption('  a\n b  ', 10)).toBe('a b');
  });
  it('cuts the Bluesky text to 300 graphemes including the whole link', () => {
    const b = blueskyPost('émoji 👨‍👩‍👧 '.repeat(60), LINK);
    expect(graphemes(b.text).length).toBeLessThanOrEqual(300);
    expect(b.text.endsWith(LINK)).toBe(true);
  });
  it('puts the link facet on UTF-8 byte offsets', () => {
    const b = blueskyPost('Café — review', LINK);
    const bytes = Buffer.from(b.text, 'utf8');
    const f = b.facets[0];
    expect(f?.index.byteStart).toBe(Buffer.byteLength('Café — review '));
    expect(f?.index.byteStart).not.toBe('Café — review '.length); // multi-byte: offsets differ from char counts
    expect(bytes.subarray(f?.index.byteStart, f?.index.byteEnd).toString('utf8')).toBe(LINK);
    expect(f?.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#link', uri: LINK });
  });
});

const X_CREDS = JSON.stringify({ apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' });
const BSKY_CREDS = JSON.stringify({ handle: '@guildwise.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
const payload = (accessToken: string) => ({
  accountId: 'x',
  accessToken,
  text: 'Café — review',
  link: LINK,
  title: 'T',
  description: 'D',
  imageUrl: 'https://guildwise.example/blog/cover/ai-agents.png',
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe('X adapter', () => {
  it('posts JSON with an OAuth 1.0a header and returns the status url', async () => {
    const f = vi.fn(async () => json(201, { data: { id: '123' } }));
    vi.stubGlobal('fetch', f);
    const r = await createSocialClient().post('x', payload(X_CREDS));
    expect(r).toEqual({ externalId: '123', url: 'https://x.com/i/web/status/123' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.x.com/2/tweets');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^OAuth .*oauth_signature=/);
    expect(JSON.parse(init.body as string)).toEqual({ text: `Café — review ${LINK}` });
  });
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'auth'],
    [429, 'retry'],
    [503, 'retry'],
    [400, 'final'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    vi.stubGlobal('fetch', async () => json(status, { title: 'x' }));
    await expect(createSocialClient().post('x', payload(X_CREDS))).rejects.toMatchObject({ kind });
  });
  it('treats unusable stored credentials as an auth problem', async () => {
    await expect(createSocialClient().post('x', payload('nope'))).rejects.toBeInstanceOf(SocialError);
  });
});

describe('Bluesky adapter', () => {
  const route = (over: Record<string, () => Response> = {}) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const h = Object.entries(over).find(([k]) => url.endsWith(k))?.[1];
      if (h) return h();
      if (url.endsWith('createSession')) return json(200, { accessJwt: 'jwt', did: 'did:plc:abc' });
      if (url.endsWith('cover/ai-agents.png'))
        return new Response(new Uint8Array(100), { headers: { 'content-type': 'image/png' } });
      if (url.endsWith('uploadBlob')) return json(200, { blob: { $type: 'blob', size: 100 } });
      if (url.endsWith('createRecord'))
        return json(200, { uri: 'at://did:plc:abc/app.bsky.feed.post/3kabc', cid: 'c' });
      throw new Error(`unexpected ${url}`);
    });
    return calls;
  };
  const record = (calls: Array<{ url: string; init: RequestInit }>) =>
    JSON.parse(calls.find((c) => c.url.endsWith('createRecord'))?.init.body as string);

  it('creates a session, uploads the thumb and posts with facet and embed', async () => {
    const calls = route();
    const r = await createSocialClient().post('bluesky', payload(BSKY_CREDS));
    expect(r.url).toBe('https://bsky.app/profile/guildwise.bsky.social/post/3kabc');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      identifier: 'guildwise.bsky.social',
      password: 'abcd-efgh-ijkl-mnop',
    });
    const rec = record(calls);
    expect(rec.repo).toBe('did:plc:abc');
    expect(rec.collection).toBe('app.bsky.feed.post');
    expect(rec.record.facets[0].index.byteStart).toBe(Buffer.byteLength('Café — review '));
    expect(rec.record.embed.external).toMatchObject({ uri: LINK, title: 'T', thumb: { $type: 'blob' } });
  });
  it('still posts without a thumb when the image cannot be fetched or is too big', async () => {
    let calls = route({ 'ai-agents.png': () => new Response('', { status: 404 }) });
    await createSocialClient().post('bluesky', payload(BSKY_CREDS));
    expect(record(calls).record.embed.external.thumb).toBeUndefined();
    calls = route({ 'ai-agents.png': () => new Response(new Uint8Array(1_000_001)) });
    await createSocialClient().post('bluesky', payload(BSKY_CREDS));
    expect(calls.some((c) => c.url.endsWith('uploadBlob'))).toBe(false);
    expect(record(calls).record.embed.external.thumb).toBeUndefined();
  });
  it('maps a refused login to auth, 429 to retry, other 4xx to final', async () => {
    route({ createSession: () => json(401, { error: 'AuthenticationRequired' }) });
    await expect(createSocialClient().post('bluesky', payload(BSKY_CREDS))).rejects.toMatchObject({
      kind: 'auth',
    });
    route({ createRecord: () => json(429, {}) });
    await expect(createSocialClient().post('bluesky', payload(BSKY_CREDS))).rejects.toMatchObject({
      kind: 'retry',
    });
    route({ createRecord: () => json(400, {}) });
    await expect(createSocialClient().post('bluesky', payload(BSKY_CREDS))).rejects.toMatchObject({
      kind: 'final',
    });
  });
});
