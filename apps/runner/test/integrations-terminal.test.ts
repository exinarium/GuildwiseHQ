import { describe, expect, it } from 'vitest';
import { parseSetupToken } from '../src/integrations/claude-code.ts';
import { parseGhDevice } from '../src/integrations/github.ts';
import { parseMcpLogin } from '../src/integrations/mcp.ts';
import { cleanTerminal, findUrl, hyperlinks, isPublicHost } from '../src/integrations/terminal.ts';
import { fixture } from './integrations-helpers.ts';

const tr = (raw: string, sinceInput?: string) => ({
  raw,
  text: cleanTerminal(raw),
  sinceInput: sinceInput ?? cleanTerminal(raw),
  inputs: sinceInput === undefined ? 0 : 1,
});

describe('terminal transcripts recorded from the real CLIs (claude 2.1.299, gh 2.102)', () => {
  it('claude setup-token: the full URL comes from the OSC 8 link, the prompt is "Paste code here"', () => {
    const raw = fixture('s1.raw.txt');
    expect(hyperlinks(raw)[0]).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/);
    const text = cleanTerminal(raw);
    expect(text).toContain("Browser didn't open? Use the url below to sign in");
    expect(text).toContain('Paste code here if prompted >');
    const r = parseSetupToken(tr(raw));
    expect(r.awaiting).toBe('code');
    expect(r.prompt?.urlHost).toBe('claude.com');
    expect(r.prompt?.url).toContain(
      'redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
    );
    expect(r.prompt?.url).toContain('scope=user%3Ainference');
    expect(r.done).toBeUndefined();
  });

  it('claude setup-token: a wrong code is an OAuth error, not a hang', () => {
    const raw = fixture('s1b.raw.txt');
    expect(cleanTerminal(raw)).toMatch(/OAuth error/);
    const r = parseSetupToken(tr(raw));
    expect(r.failed).toMatch(/did not accept the code/);
  });

  it('claude setup-token: finds the token the CLI prints, and only a real one', () => {
    const base = fixture('s1.raw.txt');
    const token = `sk-ant-oat01-${'A1b2C3d4'.repeat(8)}`;
    const ok = parseSetupToken(tr(`${base}\r\nYour OAuth token (valid for 1 year):\r\n\r\n${token}\r\n`));
    expect(ok.done).toBe(true);
    expect(ok.secrets).toEqual([token]);
    // help text with a placeholder is not a token
    expect(
      parseSetupToken(tr(`${base}\r\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...\r\n`)).done,
    ).toBeUndefined();
  });

  it('claude mcp login --no-browser: URL, paste prompt and the wrong-address retry', () => {
    const raw = fixture('s2.raw.txt');
    const r = parseMcpLogin(tr(raw));
    expect(r.awaiting).toBe('code');
    expect(r.prompt?.urlHost).toBe('mcp.atlassian.com');
    expect(r.prompt?.inputKind).toBe('redirect_url');
    expect(r.prompt?.url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3APORT%2Fcallback');
    // before anything was pasted there is no retry; after a paste the "doesn't look like" line is one
    expect(parseMcpLogin(tr(raw.split('Or paste')[0] as string)).awaiting).toBe('user');
    const after = fixture('s2.raw.txt').slice(fixture('s2.raw.txt').indexOf("That doesn't"));
    expect(parseMcpLogin(tr(raw, after)).retry).toMatch(/did not match this sign-in/);
  });

  it('gh auth login --web: the one-time code and the device URL', () => {
    const raw = fixture('s3.raw.txt');
    const r = parseGhDevice('github.com')(tr(raw));
    expect(r.awaiting).toBe('user');
    expect(r.prompt).toMatchObject({
      url: 'https://github.com/login/device',
      urlHost: 'github.com',
      inputKind: 'none',
    });
    expect(r.prompt?.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // another host's page is not offered
    expect(parseGhDevice('ghe.acme.com')(tr(raw)).prompt).toBeUndefined();
  });
});

describe('terminal helpers', () => {
  it('joins a URL a narrow terminal wrapped, refuses other hosts and local addresses', () => {
    const wrapped =
      'Open:\r\nhttps://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F\r\n%2Flocalhost%3A1%2Fcb&state=zzz\r\n\r\nWaiting';
    expect(findUrl(wrapped)).toBe(
      'https://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=zzz',
    );
    expect(findUrl(wrapped, (u) => u.hostname === 'other.example.com')).toBeUndefined();
    expect(isPublicHost('localhost')).toBe(false);
    expect(isPublicHost('127.0.0.1')).toBe(false);
    expect(isPublicHost('auth.atlassian.com')).toBe(true);
  });

  it('turns cursor-to-column escapes into spaces and strips colours', () => {
    expect(cleanTerminal('Welcome\x1b[9Gto\x1b[12GClaude\x1b[31m!\x1b[0m')).toBe('Welcome to Claude!');
  });
});
