import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { FetchedUrls } from '../src/feeds/validation.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { preparePublication } from '../src/research/publish.ts';
import { captionsToText, htmlToText, jsonTranscriptToText } from '../src/transcript/convert.ts';
import {
  type Exec,
  fetchTranscript,
  htmlTranscriptLinks,
  isVideoHost,
  MAX_TRANSCRIPT_CHARS,
  podcastTranscriptLinks,
} from '../src/transcript/fetch.ts';
import { renderTranscriptMessage, transcriptPath } from '../src/transcript/service.ts';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('captions to plain text', () => {
  it('collapses rolling auto-captions, strips tags and decodes entities', () => {
    expect(captionsToText(fixture('rolling-auto.vtt'))).toBe(
      "welcome to the channel today we test six rifle scopes and it's > harder than it looks.",
    );
  });

  it('reads manual WebVTT with cue ids, notes and styling, and keeps a repeated phrase that is not a rolling repeat', () => {
    const vtt = `WEBVTT

NOTE this is a comment
spanning two lines

STYLE
::cue { color: red }

intro
00:00:01.000 --> 00:00:03.000
<v Host>Hello and welcome.

2
00:00:03.500 --> 00:00:05.000
Yes.

3
00:00:09.000 --> 00:00:10.000
Hello and welcome.
`;
    // "Hello and welcome." is inside the dedupe window only when it directly repeats: here it is the 3rd line
    expect(captionsToText(vtt)).toBe('Hello and welcome. Yes.');
  });

  it('reads SRT with comma timestamps', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\nFirst line\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond <i>line</i>\n';
    expect(captionsToText(srt)).toBe('First line Second line');
  });

  it('reads Podcasting 2.0 JSON with speakers and plain HTML', () => {
    const json = JSON.stringify({
      version: '1.0.0',
      segments: [
        { speaker: 'Ann', startTime: 0, endTime: 2, body: 'Hi there.' },
        { speaker: 'Ann', startTime: 2, endTime: 3, body: 'Welcome.' },
        { speaker: 'Bob', startTime: 3, endTime: 4, body: 'Thanks!' },
      ],
    });
    expect(jsonTranscriptToText(json)).toBe('Ann: Hi there. Welcome.\nBob: Thanks!');
    expect(jsonTranscriptToText('not json')).toBe('');
    const html =
      '<html><nav>Menu</nav><article><h1>Talk</h1><p>First &amp; second.</p><script>x()</script><p>Third.</p></article></html>';
    expect(htmlToText(html)).toBe('Talk\n\nFirst & second.\n\nThird.');
  });
});

describe('finding published transcripts', () => {
  it('finds <podcast:transcript> tags (VTT first) and transcript links in a page', () => {
    const rss = `<item><podcast:transcript url="https://cdn.test/e1.html" type="text/html"/>
      <podcast:transcript url="/e1.vtt" type="text/vtt" language="en"/></item>`;
    expect(podcastTranscriptLinks(rss, 'https://pod.test/feed.xml').map((l) => l.url)).toEqual([
      'https://pod.test/e1.vtt',
      'https://cdn.test/e1.html',
    ]);
    const page =
      '<link rel="alternate" type="text/vtt" href="/subs.vtt"><a href="/ep1/transcript">Read the transcript</a><a href="/other">More</a>';
    expect(htmlTranscriptLinks(page, 'https://pod.test/ep1').map((l) => l.url)).toEqual([
      'https://pod.test/subs.vtt',
      'https://pod.test/ep1/transcript',
    ]);
  });

  it('knows the video hosts', () => {
    expect(isVideoHost('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isVideoHost('https://youtu.be/x')).toBe(true);
    expect(isVideoHost('https://pod.test/ep1')).toBe(false);
  });
});

const respond = (map: Record<string, { body: string; type: string }>): typeof fetch =>
  (async (url: string) => {
    const hit = map[String(url)];
    return hit
      ? new Response(hit.body, { status: 200, headers: { 'content-type': hit.type } })
      : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;

const noExec: Exec = async () => ({ code: null, stdout: '', stderr: 'spawn yt-dlp ENOENT', missing: true });

describe('fetchTranscript', () => {
  it('reports "transcript tool missing: yt-dlp" for a YouTube URL when yt-dlp is not installed', async () => {
    const r = await fetchTranscript('https://www.youtube.com/watch?v=abc', {
      exec: noExec,
      fetch: respond({}),
    });
    expect(r).toMatchObject({ status: 'tool_missing', message: 'transcript tool missing: yt-dlp' });
    expect(r.text).toBeUndefined();
    expect(renderTranscriptMessage(r)).toContain('transcript tool missing: yt-dlp');
    expect(renderTranscriptMessage(r)).toContain('aom devops "install yt-dlp"');
  });

  it('reports "no transcript available" and never invents text when the video has no captions', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: 'A talk\nA channel\n{}\n', stderr: '' });
    const r = await fetchTranscript('https://youtu.be/abc', { exec, fetch: respond({}) });
    expect(r.status).toBe('none');
    expect(r.text).toBeUndefined();
    expect(renderTranscriptMessage(r)).toMatch(/^no transcript available\nStatus: none/);
  });

  it('a podcast page with no transcript is "none" even without yt-dlp', async () => {
    const r = await fetchTranscript('https://pod.test/ep1', {
      exec: noExec,
      fetch: respond({
        'https://pod.test/ep1': { body: '<html><title>Ep 1</title><p>notes</p></html>', type: 'text/html' },
      }),
    });
    expect(r.status).toBe('none');
  });

  it('takes the transcript a podcast page links to', async () => {
    const r = await fetchTranscript('https://pod.test/ep1', {
      exec: noExec,
      fetch: respond({
        'https://pod.test/ep1': {
          body: '<html><title>Episode 1</title><a href="/ep1.vtt">Transcript</a></html>',
          type: 'text/html',
        },
        'https://pod.test/ep1.vtt': {
          body: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to episode one of the show.\n',
          type: 'text/vtt',
        },
      }),
    });
    expect(r).toMatchObject({
      status: 'ok',
      title: 'Episode 1',
      autoGenerated: false,
      text: 'Welcome to episode one of the show.',
    });
    const msg = renderTranscriptMessage(r, 'projects/x/transcripts/f.md');
    expect(msg).toContain('Title: Episode 1');
    expect(msg).toContain('Captions: published by the author');
    expect(msg).toContain('Saved: projects/x/transcripts/f.md');
  });

  it('runs yt-dlp with the documented flags, converts the VTT and marks auto-generated captions', async () => {
    const calls: string[][] = [];
    const vtt = fixture('rolling-auto.vtt');
    const exec: Exec = async (_cmd, args) => {
      calls.push(args);
      const out = args[args.indexOf('-o') + 1] as string; // <dir>/%(id)s.%(ext)s
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out.replace('%(id)s.%(ext)s', 'abc.en.vtt'), vtt);
      return { code: 0, stdout: 'Scope shootout\nOptics Channel\n{}\n', stderr: '' };
    };
    const r = await fetchTranscript('https://www.youtube.com/watch?v=abc', { exec, fetch: respond({}) });
    expect(r).toMatchObject({
      status: 'ok',
      title: 'Scope shootout',
      source: 'Optics Channel',
      language: 'en',
      autoGenerated: true,
    });
    expect(r.text).toBe(
      "welcome to the channel today we test six rifle scopes and it's > harder than it looks.",
    );
    const args = calls[0] as string[];
    for (const f of ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'vtt'])
      expect(args).toContain(f);
    expect(args[args.indexOf('--sub-langs') + 1]).toBe('en.*,en');
  });

  it('caps a huge transcript with a note', async () => {
    const exec: Exec = async (_c, args) => {
      const out = args[args.indexOf('-o') + 1] as string;
      const { writeFileSync } = await import('node:fs');
      const lines = Array.from(
        { length: 40000 },
        (_, i) =>
          `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.000\nunique line number ${i} of the talk`,
      );
      writeFileSync(out.replace('%(id)s.%(ext)s', 'abc.en.vtt'), `WEBVTT\n\n${lines.join('\n\n')}\n`);
      return { code: 0, stdout: 'T\nC\n{"en":[{}]}\n', stderr: '' };
    };
    const r = await fetchTranscript('https://youtu.be/abc', { exec, fetch: respond({}) });
    expect(r.status).toBe('ok');
    expect(r.truncated).toBe(true);
    expect(r.autoGenerated).toBe(false); // a manual English track is listed
    expect(r.text?.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 200);
    expect(r.text).toContain('[transcript truncated at');
  });

  it('an unsupported URL or a failing yt-dlp is an error result, not a crash', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Unsupported URL' });
    expect(await fetchTranscript('https://youtu.be/abc', { exec, fetch: respond({}) })).toMatchObject({
      status: 'error',
    });
    expect(await fetchTranscript('not a url', { exec, fetch: respond({}) })).toMatchObject({
      status: 'error',
    });
  });
});

describe('transcript vault paths and research links', () => {
  it('writes transcripts to <folder>/transcripts/<date>-<slug>-<hash>.md', () => {
    const p = transcriptPath(
      'projects/news',
      new Date('2026-10-05T08:00:00Z'),
      'Big Talk: Part 1!',
      'https://x.test/1',
    );
    expect(p).toMatch(/^projects\/news\/transcripts\/2026-10-05-big-talk-part-1-[a-z0-9]{1,4}\.md$/);
    expect(
      transcriptPath(
        'projects/news',
        new Date('2026-10-05T08:00:00Z'),
        'Big Talk: Part 1!',
        'https://x.test/2',
      ),
    ).not.toBe(p);
  });

  it('a fetched transcript counts as opening the source for aom publish, and the note links it', () => {
    const f = new FetchedUrls();
    f.add('https://youtu.be/abc');
    const tpath = 'projects/shooting/transcripts/2026-10-03-talk-ab12.md';
    const r = preparePublication({
      request: {
        content: '# Findings\n\nThe talk says X. [1]',
        citations: [{ url: 'https://youtu.be/abc', title: 'The talk' }],
      },
      folder: 'projects/shooting',
      card: { ref: 'SHOOT-1', subCategory: 'Hunting' },
      fetched: f,
      transcripts: new Map([['youtu.be/abc', { path: tpath, title: 'The talk' }]]),
      at: new Date('2026-10-03T08:00:00Z'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.publication.citations[0]).toMatchObject({ url: 'https://youtu.be/abc', transcriptPath: tpath });
    expect(r.content).toContain('transcript: projects/shooting/transcripts/2026-10-03-talk-ab12.md');
    expect(r.content).toContain('## Transcripts');
    expect(r.content).toContain('- [The talk](../transcripts/2026-10-03-talk-ab12.md)');
    // without the fetch the same citation is refused
    const unopened = preparePublication({
      request: { content: '# F\n\nx', citations: [{ url: 'https://youtu.be/abc', title: 'The talk' }] },
      folder: 'projects/shooting',
      card: { ref: 'SHOOT-1' },
      fetched: new FetchedUrls(),
      at: new Date(),
    });
    expect(unopened).toMatchObject({ ok: false });
  });
});

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe('aom transcript', () => {
  async function cli(rpcResult: unknown) {
    const ipc = new IpcServer();
    servers.push(ipc);
    await ipc.start();
    const calls: Array<{ method: string; params: unknown }> = [];
    const token = ipc.registerShift({
      report: async () => ({ accepted: true, message: 'Recorded.' }),
      rpc: async (req) => {
        calls.push({ method: req.method, params: req.params });
        return { ok: true, result: rpcResult };
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const ctx: AomContext = {
      env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      fetch,
      readFile: () => '',
    };
    return { run: (...a: string[]) => runAom(a, ctx), calls, out, err };
  }

  it('sends the URL to the runner and prints its message; exit code 0', async () => {
    const c = await cli({ status: 'ok', message: 'Status: ok\nTitle: Talk\n\nhello' });
    expect(await c.run('transcript', '--url', 'https://youtu.be/abc')).toBe(0);
    expect(c.calls).toEqual([{ method: 'transcript.fetch', params: { url: 'https://youtu.be/abc' } }]);
    expect(c.out.join('')).toContain('Title: Talk');
  });

  it('prints the no-tool and no-transcript results with exit code 0', async () => {
    const missing = await cli({
      status: 'tool_missing',
      message: 'transcript tool missing: yt-dlp\nStatus: tool_missing',
    });
    expect(await missing.run('transcript', '--url', 'https://youtu.be/abc')).toBe(0);
    expect(missing.out.join('')).toContain('transcript tool missing: yt-dlp');
    const none = await cli({ status: 'none', message: 'no transcript available\nStatus: none' });
    expect(await none.run('transcript', '--url', 'https://pod.test/1')).toBe(0);
    expect(none.out.join('')).toContain('no transcript available');
  });

  it('needs --url', async () => {
    const c = await cli({});
    expect(await c.run('transcript')).toBe(1);
    expect(c.err.join('')).toContain('usage: aom transcript --url');
  });
});
