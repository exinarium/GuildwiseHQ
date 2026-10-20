import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from '../src/adapters/claude-stream-parser.ts';
import { redactSecrets } from '../src/redact.ts';

describe('redactSecrets', () => {
  it.each([
    ['{"password":"hunter2hunter2"}', 'hunter2'],
    ['{"api_key": "abc123def456"}', 'abc123'],
    ['{"token":"tok_live_9999"}', 'tok_live'],
    ['{"client_secret": "s3cr3t-value"}', 's3cr3t'],
    ['{"headers":{"Authorization":"Basic dXNlcjpwYXNz"}}', 'dXNlcjpwYXNz'],
    ['curl -H "Authorization: Bearer abcdef0123456789"', 'abcdef0123456789'],
    ['https://api.example.com/x?user=1&token=abc123xyz&b=2', 'abc123xyz'],
    ['https://x.test/f?sig=AbCdEf&key=KKKK1234', 'AbCdEf'],
    ['use sk-abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['git clone https://ghp_abcdefghijklmnopqrstuvwx@github.com/a/b', 'ghp_abcdefghijklmnopqrstuvwx'],
  ])('hides the secret in %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('{"path":"/src/a.ts","limit":20}')).toBe('{"path":"/src/a.ts","limit":20}');
  });
});

describe('summarizeToolInput redacts every tool, before the cut', () => {
  it('an MCP tool input with a password', () => {
    const s = summarizeToolInput('mcp__db__query', { sql: 'select 1', password: 'hunter2hunter2' });
    expect(s).not.toContain('hunter2');
  });
  it('a WebFetch URL with a token', () => {
    const s = summarizeToolInput('WebFetch', { url: 'https://x.test/a?token=supersecretvalue&x=1' });
    expect(s).not.toContain('supersecretvalue');
  });
  it('a secret straddling the 200-character cut leaves no head behind', () => {
    const secret = 'SECRETHEAD0123456789TAIL';
    const s = summarizeToolInput('mcp__x__call', { note: 'a'.repeat(160), password: secret });
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s).not.toContain('SECRETHEAD');
    expect(s).not.toContain('SECRET');
  });
  it('a Bash command with a secret near the cut', () => {
    const s = summarizeToolInput('Bash', { command: `${'x'.repeat(185)} --password hunter2hunter2hunter2` });
    expect(s).not.toContain('hunter2');
  });
});
